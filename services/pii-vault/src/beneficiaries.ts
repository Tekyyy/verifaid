import { openEnvelope, sealEnvelope } from '@poa/shared'
import { prisma } from '@poa/shared/db'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { type Address, getAddress } from 'viem'
import { z } from 'zod'
import { audit } from './audit.js'
import { requireSession, sessionAddress } from './auth.js'
import { programOwner, requireActiveNgo } from './chain.js'
import type { RouteDeps } from './deps.js'
import { conflict, forbidden, gone, notFound } from './errors.js'
import { ngoContext } from './keys.js'

/**
 * Beneficiary records: the one place in the system where a name exists, and since v9 the only place the people an
 * NGO serves exist at all — the chain holds programmes, never people. (Since v10 a beneficiary the NGO certified may
 * post a need of their own; the chain then holds their wallet, and nothing from here.) `commitment` is the NGO's own
 * opaque reference for a household (a card number, a random id), unique within its programme; the profile is sealed
 * under a per-NGO key and can be destroyed on request (spec §8.2, right to erasure).
 */

const DecimalSchema = z.string().regex(/^\d+$/, 'must be a decimal integer string')

/** Open-ended on purpose: what an NGO records about a household differs per program and per country. */
const ProfileSchema = z
  .object({
    name: z.string().min(1).max(200),
    contact: z.string().max(200).optional(),
    householdSize: z.number().int().positive().max(50).optional(),
    address: z.string().max(400).optional(),
    notes: z.string().max(4000).optional(),
  })
  .catchall(z.unknown())

const BeneficiarySummarySchema = z.object({
  id: z.string(),
  commitment: z.string(),
  programId: z.string(),
  createdAt: z.string(),
  shredded: z.boolean(),
  shreddedAt: z.string().nullable(),
})

export const registerBeneficiaryRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const typed = app.withTypeProvider<ZodTypeProvider>()
  const guard = requireSession(deps.config)

  typed.post(
    '/beneficiaries',
    {
      preHandler: guard,
      schema: {
        tags: ['beneficiaries'],
        summary: 'Enrol a beneficiary (owning NGO)',
        description:
          'Encrypts the profile under the NGO key and stores it under the NGO\'s own reference for the household. ' +
          'The profile is never returned by any list endpoint.',
        security: [{ bearerAuth: [] }],
        body: z.object({
          programId: DecimalSchema,
          commitment: DecimalSchema,
          profile: ProfileSchema,
        }),
        response: { 201: z.object({ id: z.string(), commitment: z.string(), programId: z.string() }) },
      },
    },
    async (request, reply) => {
      const caller = sessionAddress(request)
      await assertOwnsProgram(deps, request, caller, request.body.programId)

      const sealed = sealEnvelope(
        deps.masterKey,
        ngoContext(caller),
        Buffer.from(JSON.stringify(request.body.profile), 'utf8'),
      )

      const existing = await prisma().beneficiary.findUnique({
        where: {
          programId_commitment: { programId: request.body.programId, commitment: request.body.commitment },
        },
      })
      if (existing) throw conflict('This identity commitment is already enrolled in the program')

      const record = await prisma().beneficiary.create({
        data: {
          ngoAddress: caller,
          programId: request.body.programId,
          commitment: request.body.commitment,
          ciphertext: new Uint8Array(sealed.box),
          wrappedDek: new Uint8Array(sealed.wrappedDek),
        },
      })

      audit(request.log, { event: 'beneficiary.created', actor: caller, subject: record.id, role: 'ngo' })
      reply.status(201)
      return { id: record.id, commitment: record.commitment, programId: record.programId }
    },
  )

  typed.get(
    '/beneficiaries',
    {
      preHandler: guard,
      schema: {
        tags: ['beneficiaries'],
        summary: 'List enrolled beneficiaries of one program (owning NGO)',
        description: 'Identifiers, commitments and timestamps only — no personal data is ever returned here.',
        security: [{ bearerAuth: [] }],
        querystring: z.object({ programId: DecimalSchema }),
        response: {
          200: z.object({
            programId: z.string(),
            count: z.number(),
            beneficiaries: z.array(BeneficiarySummarySchema),
          }),
        },
      },
    },
    async (request) => {
      const caller = sessionAddress(request)
      await assertOwnsProgram(deps, request, caller, request.query.programId)

      const records = await prisma().beneficiary.findMany({
        where: { programId: request.query.programId, ngoAddress: caller },
        orderBy: { createdAt: 'asc' },
      })

      audit(request.log, {
        event: 'beneficiary.listed',
        actor: caller,
        subject: `program:${request.query.programId}`,
        role: 'ngo',
      })
      return {
        programId: request.query.programId,
        count: records.length,
        beneficiaries: records.map((record) => ({
          id: record.id,
          commitment: record.commitment,
          programId: record.programId,
          createdAt: record.createdAt.toISOString(),
          shredded: record.wrappedDek === null,
          shreddedAt: record.shreddedAt?.toISOString() ?? null,
        })),
      }
    },
  )

  typed.get(
    '/beneficiaries/:id',
    {
      preHandler: guard,
      schema: {
        tags: ['beneficiaries'],
        summary: 'Read one decrypted profile (owning NGO)',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({
            id: z.string(),
            programId: z.string(),
            commitment: z.string(),
            createdAt: z.string(),
            profile: z.unknown(),
          }),
        },
      },
    },
    async (request) => {
      const caller = sessionAddress(request)
      const record = await prisma().beneficiary.findUnique({ where: { id: request.params.id } })
      if (!record) throw notFound('No such beneficiary record')

      if (getAddress(record.ngoAddress) !== caller || !(await requireActiveNgo(deps.chain, caller))) {
        audit(request.log, {
          event: 'access.denied',
          actor: caller,
          subject: record.id,
          reason: 'not the owning NGO',
        })
        throw forbidden('Only the active NGO that enrolled this beneficiary may read the profile')
      }
      if (!record.wrappedDek) {
        throw gone('This record was crypto-shredded: its data key is gone and the ciphertext cannot be read')
      }

      const profile = JSON.parse(
        openEnvelope(
          deps.masterKey,
          ngoContext(getAddress(record.ngoAddress)),
          Buffer.from(record.wrappedDek),
          Buffer.from(record.ciphertext),
        ).toString('utf8'),
      ) as unknown

      audit(request.log, { event: 'beneficiary.read', actor: caller, subject: record.id, role: 'ngo' })
      return {
        id: record.id,
        programId: record.programId,
        commitment: record.commitment,
        createdAt: record.createdAt.toISOString(),
        profile,
      }
    },
  )

  typed.delete(
    '/beneficiaries/:id',
    {
      preHandler: guard,
      schema: {
        tags: ['beneficiaries'],
        summary: 'Erase a beneficiary by destroying its data key',
        description:
          'Crypto-shredding: the wrapped DEK is deleted, which makes the stored ciphertext permanently ' +
          'unreadable. Nothing on chain refers to the beneficiary, so nothing else needs to change.',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({
            id: z.string(),
            commitment: z.string(),
            programId: z.string(),
            shreddedAt: z.string(),
            alreadyShredded: z.boolean(),
          }),
        },
      },
    },
    async (request) => {
      const caller = sessionAddress(request)
      const record = await prisma().beneficiary.findUnique({ where: { id: request.params.id } })
      if (!record) throw notFound('No such beneficiary record')
      if (getAddress(record.ngoAddress) !== caller) {
        audit(request.log, {
          event: 'access.denied',
          actor: caller,
          subject: record.id,
          reason: 'not the owning NGO',
        })
        throw forbidden('Only the NGO that enrolled this beneficiary may erase the record')
      }

      // Erasure stays available even if the NGO was deactivated: the right to erasure is not the NGO's to lose.
      const alreadyShredded = record.wrappedDek === null
      const updated = alreadyShredded
        ? record
        : await prisma().beneficiary.update({
            where: { id: record.id },
            data: { wrappedDek: null, shreddedAt: new Date() },
          })

      audit(request.log, { event: 'beneficiary.shredded', actor: caller, subject: record.id, role: 'ngo' })
      return {
        id: updated.id,
        commitment: updated.commitment,
        programId: updated.programId,
        shreddedAt: (updated.shreddedAt ?? new Date()).toISOString(),
        alreadyShredded,
      }
    },
  )
}

/** Program ownership is a chain fact; a row claiming an NGO address proves nothing on its own. */
const assertOwnsProgram = async (
  deps: RouteDeps,
  request: { log: FastifyBaseLogger },
  caller: Address,
  programId: string,
): Promise<void> => {
  const subject = `program:${programId}`
  if (!(await requireActiveNgo(deps.chain, caller))) {
    audit(request.log, { event: 'access.denied', actor: caller, subject, reason: 'not an active NGO' })
    throw forbidden('Caller is not an active NGO')
  }
  if (getAddress(await programOwner(deps.chain, BigInt(programId))) !== caller) {
    audit(request.log, { event: 'access.denied', actor: caller, subject, reason: 'not the program owner' })
    throw forbidden('Caller does not own this program on-chain')
  }
}
