import { openEnvelope, sealEnvelope } from '@poa/shared'
import { prisma } from '@poa/shared/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { getAddress, keccak256 } from 'viem'
import { z } from 'zod'
import { audit } from './audit.js'
import { requireSession, sessionAddress } from './auth.js'
import { isRegisteredVerifier, requireActiveNgo } from './chain.js'
import type { RouteDeps } from './deps.js'
import { forbidden, gone, notFound } from './errors.js'
import { ngoContext } from './keys.js'

/**
 * Needs assessments. The chain carries only `dossierHash`, and the `NeedVerified` resolver refuses an
 * attestation whose hash does not match the need — so a verifier who decrypts a dossier here can prove the
 * document they read is the one the need was registered with, by comparing `ciphertextHash` with the chain.
 */

const HashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hash')

const AssessmentSchema = z
  .object({
    summary: z.string().min(1).max(8000),
    households: z.number().int().positive().max(1_000_000).optional(),
    methodology: z.string().max(8000).optional(),
    sources: z.array(z.string().max(500)).max(50).optional(),
  })
  .catchall(z.unknown())

export const registerDossierRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const typed = app.withTypeProvider<ZodTypeProvider>()
  const guard = requireSession(deps.config)

  typed.post(
    '/dossiers',
    {
      preHandler: guard,
      schema: {
        tags: ['dossiers'],
        summary: 'Store an encrypted needs assessment (NGO)',
        description:
          'Returns `hash` = keccak256 of the ciphertext. That value goes on-chain as the need’s `dossierHash`; ' +
          'nothing about the assessment itself ever does.',
        security: [{ bearerAuth: [] }],
        body: z.object({
          assessment: AssessmentSchema,
          /** Optional back-reference, set once the need exists on-chain. */
          needId: z.string().regex(/^\d+$/).optional(),
        }),
        response: {
          201: z.object({ hash: z.string(), ngoAddress: z.string(), needId: z.string().nullable() }),
        },
      },
    },
    async (request, reply) => {
      const caller = sessionAddress(request)
      if (!(await requireActiveNgo(deps.chain, caller))) {
        audit(request.log, { event: 'access.denied', actor: caller, reason: 'not an active NGO' })
        throw forbidden('Caller is not an active NGO')
      }

      const sealed = sealEnvelope(
        deps.masterKey,
        ngoContext(caller),
        Buffer.from(JSON.stringify(request.body.assessment), 'utf8'),
      )
      const hash = keccak256(sealed.box)

      // Re-sealing the same assessment produces a different ciphertext and therefore a different hash, so an
      // upsert keeps the first version rather than orphaning a hash a need may already point at.
      const record = await prisma().dossier.upsert({
        where: { hash },
        update: { needId: request.body.needId ?? undefined },
        create: {
          hash,
          ngoAddress: caller,
          needId: request.body.needId ?? null,
          ciphertext: new Uint8Array(sealed.box),
          wrappedDek: new Uint8Array(sealed.wrappedDek),
        },
      })

      audit(request.log, { event: 'dossier.created', actor: caller, subject: hash, role: 'ngo' })
      reply.status(201)
      return { hash: record.hash, ngoAddress: record.ngoAddress, needId: record.needId }
    },
  )

  typed.get(
    '/dossiers/:hash',
    {
      preHandler: guard,
      schema: {
        tags: ['dossiers'],
        summary: 'Read a decrypted needs assessment (owning NGO or a registered verifier)',
        description:
          '`ciphertextHash` is recomputed from the stored bytes on every read, so a verifier can compare it ' +
          'with the need’s on-chain `dossierHash` before trusting what they just read.',
        security: [{ bearerAuth: [] }],
        params: z.object({ hash: HashSchema }),
        response: {
          200: z.object({
            hash: z.string(),
            ciphertextHash: z.string(),
            hashMatches: z.boolean(),
            ngoAddress: z.string(),
            needId: z.string().nullable(),
            role: z.string(),
            createdAt: z.string(),
            assessment: z.unknown(),
          }),
        },
      },
    },
    async (request) => {
      const caller = sessionAddress(request)
      const hash = request.params.hash.toLowerCase()
      const record = await prisma().dossier.findUnique({ where: { hash } })
      if (!record) throw notFound('No dossier stored for that hash')

      const owner = getAddress(record.ngoAddress)
      const role =
        owner === caller && (await requireActiveNgo(deps.chain, caller))
          ? 'ngo'
          : (await isRegisteredVerifier(deps.chain, caller))
            ? 'verifier'
            : null
      if (!role) {
        audit(request.log, {
          event: 'access.denied',
          actor: caller,
          subject: hash,
          reason: 'not NGO or verifier',
        })
        throw forbidden('Only the owning NGO or a registered verifier may read a dossier')
      }
      if (!record.wrappedDek) throw gone('This dossier was crypto-shredded and can no longer be read')

      const ciphertext = Buffer.from(record.ciphertext)
      const assessment = JSON.parse(
        openEnvelope(deps.masterKey, ngoContext(owner), Buffer.from(record.wrappedDek), ciphertext).toString(
          'utf8',
        ),
      ) as unknown

      audit(request.log, { event: 'dossier.read', actor: caller, subject: hash, role })
      const ciphertextHash = keccak256(ciphertext)
      return {
        hash: record.hash,
        ciphertextHash,
        hashMatches: ciphertextHash === record.hash,
        ngoAddress: record.ngoAddress,
        needId: record.needId,
        role,
        createdAt: record.createdAt.toISOString(),
        assessment,
      }
    },
  )
}
