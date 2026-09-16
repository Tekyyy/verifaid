import { openEnvelope, regionCode as regionCodeHex, rewrapDek, sealEnvelope } from '@poa/shared'
import { type Prisma, prisma } from '@poa/shared/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { type Address, getAddress, keccak256 } from 'viem'
import { z } from 'zod'
import { audit } from './audit.js'
import { requireSession, sessionAddress } from './auth.js'
import { type BundleFileInput, buildBundle, decodeBundle, ManifestSchema } from './bundle.js'
import { type Chain, getDeliveryContext, isFieldAgentOf, resolveEvidenceRole } from './chain.js'
import type { EvidenceConfig } from './config.js'
import { badRequest, forbidden, gone, notFound } from './errors.js'
import type { IpfsClient } from './ipfs.js'
import { grantContext, ngoContext } from './keys.js'

/** Open, per IDeliveryManager.DeliveryStatus — evidence can only be filed against an open delivery. */
const DELIVERY_STATUS_OPEN = 0

const CidSchema = z
  .string()
  .min(10)
  .max(120)
  .regex(/^[A-Za-z0-9]+$/, 'must be a bare CID')

const FileMetaSchema = z.object({
  name: z.string(),
  contentType: z.string(),
  size: z.number(),
  sha256: z.string(),
  format: z.string(),
  removedMetadata: z.array(z.string()),
})

export interface RouteDeps {
  config: EvidenceConfig
  chain: Chain
  ipfs: IpfsClient
  masterKey: Buffer
}

/** Narrows a typed object to the plain JSON shape Prisma's `Json` columns accept. */
const toJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

export const registerEvidenceRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const typed = app.withTypeProvider<ZodTypeProvider>()
  const guard = requireSession(deps.config)

  typed.post(
    '/evidence',
    {
      preHandler: guard,
      schema: {
        tags: ['evidence'],
        summary: 'Upload delivery evidence (field agent)',
        description: [
          'Multipart upload: one `manifest` field holding JSON',
          '(`deliveryId`, `itemsDelivered`, `regionCode`, optional `notes`) plus one or more files.',
          'Image metadata is stripped, the bundle is envelope-encrypted and the ciphertext is pinned to IPFS.',
          'The returned `evidenceHash` is keccak256 of the ciphertext and is the value the field agent puts in the',
          'on-chain `DeliveryEvidence` attestation.',
        ].join(' '),
        consumes: ['multipart/form-data'],
        security: [{ bearerAuth: [] }],
        response: {
          201: z.object({
            cid: z.string(),
            evidenceHash: z.string(),
            deliveryId: z.string(),
            ciphertextBytes: z.number(),
            backend: z.string(),
            strippedMetadata: z.array(z.string()),
            files: z.array(FileMetaSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const caller = sessionAddress(request)
      if (!request.isMultipart()) throw badRequest('Expected a multipart/form-data upload')

      let rawManifest: string | undefined
      const files: BundleFileInput[] = []
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (files.length >= deps.config.maxFiles) {
            throw badRequest(`At most ${deps.config.maxFiles} files per upload`, 'TOO_MANY_FILES')
          }
          const data = await part.toBuffer()
          if (data.length === 0) throw badRequest(`File "${part.filename}" is empty`)
          files.push({
            name: part.filename ?? part.fieldname,
            contentType: part.mimetype || 'application/octet-stream',
            data,
          })
        } else if (part.fieldname === 'manifest') {
          rawManifest = String(part.value)
        }
      }

      if (!rawManifest) throw badRequest('Missing `manifest` field')
      if (files.length === 0) throw badRequest('At least one file is required')

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(rawManifest)
      } catch {
        throw badRequest('`manifest` is not valid JSON')
      }
      const manifest = ManifestSchema.safeParse(parsedJson)
      if (!manifest.success) throw badRequest(`Invalid manifest: ${z.prettifyError(manifest.error)}`)

      // Authority comes from the chain, never from the upload.
      const delivery = await getDeliveryContext(deps.chain, BigInt(manifest.data.deliveryId))
      if (!delivery) throw notFound(`Delivery ${manifest.data.deliveryId} does not exist`)
      if (getAddress(delivery.fieldAgent) !== caller) {
        throw forbidden('Only the field agent that opened this delivery may upload its evidence')
      }
      if (!(await isFieldAgentOf(deps.chain.roles, caller, delivery.ngo))) {
        throw forbidden('Caller is no longer a field agent of this delivery’s NGO')
      }
      if (delivery.status !== DELIVERY_STATUS_OPEN) {
        throw badRequest('Delivery is no longer open for evidence', 'DELIVERY_NOT_OPEN')
      }
      if (regionCodeHex(manifest.data.regionCode).toLowerCase() !== delivery.regionCode.toLowerCase()) {
        // The resolver rejects a region mismatch on-chain; failing here saves an unusable upload.
        throw badRequest('regionCode does not match the need on-chain', 'REGION_MISMATCH')
      }

      const bundle = buildBundle(manifest.data, files)
      const sealed = sealEnvelope(deps.masterKey, ngoContext(delivery.ngo), bundle.payload)
      const evidenceHash = keccak256(sealed.box)
      const { cid, backend } = await deps.ipfs.put(sealed.box, `${evidenceHash}.bin`)

      await prisma().evidence.create({
        data: {
          cid,
          evidenceHash,
          deliveryId: delivery.deliveryId.toString(),
          ngoAddress: getAddress(delivery.ngo),
          uploader: caller,
          wrappedDek: new Uint8Array(sealed.wrappedDek),
          manifest: toJson(bundle.storedManifest),
        },
      })

      audit(request.log, {
        event: 'evidence.uploaded',
        cid,
        actor: caller,
        role: 'fieldAgent',
        deliveryId: delivery.deliveryId.toString(),
      })

      reply.status(201)
      return {
        cid,
        evidenceHash,
        deliveryId: delivery.deliveryId.toString(),
        ciphertextBytes: sealed.box.length,
        backend,
        strippedMetadata: bundle.removedMetadata,
        files: bundle.storedManifest.files,
      }
    },
  )

  typed.get(
    '/evidence/:cid',
    {
      preHandler: guard,
      schema: {
        tags: ['evidence'],
        summary: 'Read a decrypted evidence bundle',
        description: [
          'Allowed for the owning NGO, the field agent that uploaded the bundle, or a verifier the RoleRegistry',
          'considers independent of that NGO. A verifier gets a `KeyGrant` on first access, so every share of a',
          'data key is a row someone can audit.',
        ].join(' '),
        security: [{ bearerAuth: [] }],
        params: z.object({ cid: CidSchema }),
        response: {
          200: z.object({
            cid: z.string(),
            evidenceHash: z.string(),
            deliveryId: z.string(),
            role: z.string(),
            manifest: z.object({
              deliveryId: z.string(),
              itemsDelivered: z.number(),
              regionCode: z.string(),
              notes: z.string().optional(),
              files: z.array(FileMetaSchema),
            }),
            files: z.array(FileMetaSchema.extend({ data: z.string() })),
          }),
        },
      },
    },
    async (request) => {
      const caller = sessionAddress(request)
      const { cid } = request.params
      const record = await prisma().evidence.findUnique({ where: { cid } })
      if (!record) throw notFound(`No evidence stored for ${cid}`)
      if (!record.wrappedDek) throw gone('The data key for this evidence was destroyed', 'SHREDDED')

      const ngo = getAddress(record.ngoAddress)
      const role = await resolveEvidenceRole(deps.chain, caller, ngo, getAddress(record.uploader))
      if (!role) {
        audit(request.log, {
          event: 'evidence.access_denied',
          cid,
          actor: caller,
          reason: 'not authorized on-chain',
        })
        throw forbidden('Not the owning NGO, its uploading field agent, or an independent verifier')
      }

      // A verifier reads through their own grant: the key they use is the one the grant recorded, so revoking
      // the row is enough to make the share auditable and, later, revocable.
      let context = ngoContext(ngo)
      let wrapped: Buffer = Buffer.from(record.wrappedDek)
      if (role === 'verifier') {
        const grant = await ensureGrant(deps, cid, ngo, caller, wrapped)
        if (grant.created) {
          audit(request.log, { event: 'evidence.grant_created', cid, actor: caller, role })
        }
        context = grantContext(caller)
        wrapped = grant.wrappedKey
      }

      const ciphertext = await deps.ipfs.get(cid)
      if (!ciphertext) throw notFound(`Ciphertext for ${cid} is not retrievable from IPFS`)
      if (keccak256(ciphertext) !== record.evidenceHash) {
        throw badRequest('Stored ciphertext does not match the anchored evidence hash', 'HASH_MISMATCH')
      }

      const bundle = decodeBundle(openEnvelope(deps.masterKey, context, wrapped, ciphertext))
      audit(request.log, {
        event: 'evidence.accessed',
        cid,
        actor: caller,
        role,
        deliveryId: record.deliveryId,
      })

      return {
        cid,
        evidenceHash: record.evidenceHash,
        deliveryId: record.deliveryId,
        role,
        manifest: bundle.manifest,
        files: bundle.files,
      }
    },
  )

  typed.get(
    '/evidence/:cid/meta',
    {
      preHandler: guard,
      schema: {
        tags: ['evidence'],
        summary: 'Non-personal metadata for one evidence bundle',
        description:
          'Hash, delivery id, the non-personal manifest and how many key grants exist. Never returns file contents or notes.',
        security: [{ bearerAuth: [] }],
        params: z.object({ cid: CidSchema }),
        response: {
          200: z.object({
            cid: z.string(),
            evidenceHash: z.string(),
            deliveryId: z.string(),
            ngo: z.string(),
            uploader: z.string(),
            shredded: z.boolean(),
            grants: z.number(),
            attestationUID: z.string().nullable(),
            createdAt: z.string(),
            manifest: z.unknown(),
          }),
        },
      },
    },
    async (request) => {
      const caller = sessionAddress(request)
      const { cid } = request.params
      const record = await prisma().evidence.findUnique({
        where: { cid },
        include: { _count: { select: { grants: true } } },
      })
      if (!record) throw notFound(`No evidence stored for ${cid}`)

      audit(request.log, { event: 'evidence.meta_read', cid, actor: caller, deliveryId: record.deliveryId })
      return {
        cid: record.cid,
        evidenceHash: record.evidenceHash,
        deliveryId: record.deliveryId,
        ngo: record.ngoAddress,
        uploader: record.uploader,
        shredded: record.wrappedDek === null,
        grants: record._count.grants,
        attestationUID: record.attestationUID,
        createdAt: record.createdAt.toISOString(),
        manifest: record.manifest,
      }
    },
  )
}

/** Finds or creates the per-verifier wrapped key. Idempotent: a second read reuses the grant it already has. */
const ensureGrant = async (
  deps: RouteDeps,
  cid: string,
  ngo: Address,
  grantee: Address,
  wrappedDek: Buffer,
): Promise<{ wrappedKey: Buffer; created: boolean }> => {
  const existing = await prisma().keyGrant.findUnique({
    where: { evidenceCid_granteeAddress: { evidenceCid: cid, granteeAddress: grantee } },
  })
  if (existing) return { wrappedKey: Buffer.from(existing.wrappedKey), created: false }

  const wrappedKey = rewrapDek(deps.masterKey, ngoContext(ngo), grantContext(grantee), wrappedDek)
  await prisma().keyGrant.create({
    data: {
      evidenceCid: cid,
      granteeAddress: grantee,
      wrappedKey: new Uint8Array(wrappedKey),
      grantedBy: ngo,
    },
  })
  return { wrappedKey, created: true }
}
