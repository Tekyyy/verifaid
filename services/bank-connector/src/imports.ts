import { CsvError, parse } from 'csv-parse/sync'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { badRequest, errorSummary, HttpError } from './errors.js'
import { parseEurAmount } from './fees.js'
import { CURRENCY_PATTERN, type FundingDeps, type FundingInstruction, recordFunding } from './funding.js'
import type { RouteDeps } from './routes.js'
import { verifySignature } from './signature.js'

/**
 * Bulk funding import (gap plan C1, integration level 2): a provider that cannot call a webhook per payment
 * uploads its day's settled transfers as CSV. Every row goes through the same pipeline as the SEPA webhook, one at
 * a time, so a file can be re-uploaded after a partial failure: rows already on-chain come back as DUPLICATE.
 */

export const IMPORT_COLUMNS = [
  'end_to_end_id',
  'need_id',
  'amount_eur',
  'fee_eur',
  'currency',
  'donor_reference',
] as const
type ImportColumn = (typeof IMPORT_COLUMNS)[number]

export const IMPORT_ROW_STATUS = ['ATTESTED', 'DUPLICATE', 'FAILED', 'INVALID'] as const
export type ImportRowStatus = (typeof IMPORT_ROW_STATUS)[number]

export interface ParsedImportRow {
  /** 1-based line of the source file where the record ended (the header is line 1). */
  line: number
  endToEndId: string
  instruction?: FundingInstruction
  /** Why the row is INVALID. Never echoes a value: the file can contain donor references. */
  error?: string
}

export interface ImportRowResult {
  line: number
  endToEndId: string
  status: ImportRowStatus
  trackingRef?: string
  error?: string
}

export interface ImportResult {
  rows: ImportRowResult[]
  summary: Record<Lowercase<ImportRowStatus>, number>
}

interface CsvRecord {
  record: string[]
  info: { lines: number }
}

/** Parses and validates the whole file up front; structural problems reject the file, row problems only the row. */
export const parseFundingCsv = (text: string, maxRows: number): ParsedImportRow[] => {
  let records: CsvRecord[]
  try {
    records = parse(text, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 16_384,
      info: true,
    }) as unknown as CsvRecord[]
  } catch (error) {
    // CsvError messages quote the offending field; report only the code and where it happened.
    if (error instanceof CsvError) {
      const line = typeof error.lines === 'number' ? error.lines : undefined
      throw badRequest(
        `The body is not valid CSV (${error.code}${line ? ` near line ${line}` : ''})`,
        'INVALID_CSV',
      )
    }
    throw badRequest('The body is not valid CSV', 'INVALID_CSV')
  }

  const [header, ...rows] = records
  if (!header) throw badRequest('The CSV file is empty; a header row is required', 'INVALID_CSV_HEADER')
  const names = header.record.map((name) => name.toLowerCase())
  const missing = IMPORT_COLUMNS.filter((column) => !names.includes(column))
  const unknown = names.filter((name) => !(IMPORT_COLUMNS as readonly string[]).includes(name))
  if (missing.length > 0 || unknown.length > 0 || new Set(names).size !== names.length) {
    throw badRequest(
      `The header row must name exactly these columns: ${IMPORT_COLUMNS.join(',')}` +
        (missing.length > 0 ? ` (missing: ${missing.join(',')})` : ''),
      'INVALID_CSV_HEADER',
    )
  }
  if (rows.length === 0) throw badRequest('The CSV file has a header but no rows', 'EMPTY_IMPORT')
  if (rows.length > maxRows) {
    throw new HttpError(413, 'TOO_MANY_ROWS', `An import is limited to ${maxRows} rows; split the file`)
  }

  const index = Object.fromEntries(IMPORT_COLUMNS.map((column) => [column, names.indexOf(column)])) as Record<
    ImportColumn,
    number
  >
  return rows.map(({ record, info }) => validateRow(record, info.lines, index, names.length))
}

const validateRow = (
  record: string[],
  line: number,
  index: Record<ImportColumn, number>,
  width: number,
): ParsedImportRow => {
  const cell = (column: ImportColumn): string => record[index[column]] ?? ''
  const endToEndId = cell('end_to_end_id')
  const invalid = (error: string): ParsedImportRow => ({ line, endToEndId: endToEndId.slice(0, 140), error })

  if (record.length !== width) return invalid(`expected ${width} columns, found ${record.length}`)
  if (endToEndId.length === 0 || endToEndId.length > 140)
    return invalid('end_to_end_id must be 1-140 characters')

  const needId = cell('need_id')
  if (!/^\d{1,78}$/.test(needId)) return invalid('need_id must be a decimal integer')

  const grossEurCents = parseEurAmount(cell('amount_eur'))
  if (grossEurCents === null || grossEurCents <= 0) {
    return invalid('amount_eur must be a positive decimal with at most 2 decimals')
  }

  const feeText = cell('fee_eur')
  const feeEurCents = feeText === '' ? 0 : parseEurAmount(feeText)
  if (feeEurCents === null) return invalid('fee_eur must be empty or a decimal with at most 2 decimals')
  if (feeEurCents > grossEurCents) return invalid('fee_eur cannot exceed amount_eur')

  const currency = (cell('currency') || 'EUR').toUpperCase()
  if (!CURRENCY_PATTERN.test(currency)) return invalid('currency must be an ISO 4217 code such as EUR')

  const donorReference = cell('donor_reference')
  if (donorReference.length === 0 || donorReference.length > 140) {
    return invalid('donor_reference must be 1-140 characters')
  }

  return {
    line,
    endToEndId,
    instruction: { endToEndId, needId, grossEurCents, feeEurCents, currency, donorReference, source: 'CSV' },
  }
}

/** Processes validated rows strictly in file order: a later row can depend on an earlier one filling a need. */
export const importFunding = async (deps: FundingDeps, parsed: ParsedImportRow[]): Promise<ImportResult> => {
  const rows: ImportRowResult[] = []
  for (const row of parsed) {
    if (!row.instruction) {
      rows.push({ line: row.line, endToEndId: row.endToEndId, status: 'INVALID', error: row.error })
      continue
    }
    try {
      const { transfer, idempotent } = await recordFunding(deps, row.instruction)
      rows.push({
        line: row.line,
        endToEndId: row.endToEndId,
        status: idempotent ? 'DUPLICATE' : 'ATTESTED',
        trackingRef: transfer.paymentRefHash,
      })
    } catch (error) {
      // Known rejections are reported as-is; anything else is logged and summarised without internals.
      const known = error instanceof HttpError
      if (!known) {
        deps.log.error(
          { event: 'import.row_failed', line: row.line, err: errorSummary(error) },
          'import row failed',
        )
      }
      rows.push({
        line: row.line,
        endToEndId: row.endToEndId,
        status: 'FAILED',
        error: known
          ? errorSummary(error)
          : 'INTERNAL_ERROR: the row could not be processed; retry the import',
      })
    }
  }

  const summary = { attested: 0, duplicate: 0, failed: 0, invalid: 0 }
  for (const row of rows) summary[row.status.toLowerCase() as keyof typeof summary] += 1
  deps.log.info({ event: 'import.completed', ...summary }, 'funding import processed')
  return { rows, summary }
}

const ImportResponseSchema = z.object({
  rows: z.array(
    z.object({
      line: z.number(),
      endToEndId: z.string(),
      status: z.enum(IMPORT_ROW_STATUS),
      trackingRef: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  summary: z.object({ attested: z.number(), duplicate: z.number(), failed: z.number(), invalid: z.number() }),
})

export const registerImportRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { config } = deps
  app.withTypeProvider<ZodTypeProvider>().post(
    '/imports/funding',
    {
      bodyLimit: config.imports.maxBytes,
      preValidation: async (request: FastifyRequest) => verifySignature(config, request),
      schema: {
        tags: ['imports'],
        summary: 'Import settled payments from a CSV file',
        description: [
          '`content-type: text/csv`, signed like the SEPA webhook (`x-poa-signature: sha256=<hmac of the raw body>`).',
          `Header row required: \`${IMPORT_COLUMNS.join(',')}\`. Amounts are decimal EUR ("12.50"); \`fee_eur\``,
          'and `currency` may be empty (0, EUR). Every row is validated first; valid rows are then processed in',
          'order through the funding pipeline, idempotent per `end_to_end_id`. Per-row status: ATTESTED, DUPLICATE',
          `(already recorded), FAILED (rejected by the pipeline or the chain), INVALID. Limits: ${config.imports.maxBytes}`,
          `bytes, ${config.imports.maxRows} rows.`,
        ].join(' '),
        consumes: ['text/csv'],
        body: z.string(),
        response: { 200: ImportResponseSchema },
      },
    },
    async (request) => {
      const parsed = parseFundingCsv(request.body, config.imports.maxRows)
      return importFunding({ config, chain: deps.chain, log: request.log }, parsed)
    },
  )
}
