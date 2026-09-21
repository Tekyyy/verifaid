import {
  type CommunitySchemaName,
  type DonationAcknowledgedData,
  decodeCommunityData,
  type NeedPresentationData,
  type OrgTaxStatusData,
  type SupplierApplicationData,
  type WorkPhotosData,
} from '@poa/shared'
import { getDeployment, resolveNetwork } from '@poa/shared'
import { eq } from 'ponder'
import schema from 'ponder:schema'
import type { Address, Hex } from 'viem'

/**
 * The two schemas with no resolver (see `RegisterCommunitySchemas.s.sol`): anyone can attest them and nothing
 * on-chain reads them, so this is where they are given meaning — and where the rules the chain does not enforce
 * are applied instead:
 *
 * - **Work photos** count only when the need's own NGO signed them. Anyone else's attestation on that need is
 *   ignored, so the "photos published" tag always means "published by the organisation accountable for it".
 * - **Supplier applications** count only when the applicant signed for itself. An application is a public
 *   request, never a grant: `SUPPLIER_ROLE` is still an admin decision on chain.
 */

/** Bounds, because this data is free to write: a page renders a handful of photos, not a thousand. */
const MAX_PHOTOS = 12
const MAX_URL = 500
const MAX_TEXT = 500
const MAX_TAGS = 5
const MAX_TAG = 40
/** An acknowledgment is a paragraph, not a document: the document is what the donor downloads. */
const MAX_STATEMENT = 2000

const trim = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value)

/** Only what a browser can render as an image src, and only from schemes a page can be told to fetch. */
const usablePhotos = (photos: readonly string[]): string[] =>
  photos
    .filter((url) => /^(https:\/\/|ipfs:\/\/)/i.test(url.trim()) && url.trim().length <= MAX_URL)
    .slice(0, MAX_PHOTOS)
    .map((url) => url.trim())

/**
 * Who the platform admin is, for this deployment. An `OrgTaxStatus` attestation signed by that address is what
 * turns a claim into a verification — the chain cannot check an EIN, but it can record who says they did.
 */
const ADMIN = getDeployment(resolveNetwork(process.env.PONDER_NETWORK ?? 'anvil')).admin.toLowerCase()

interface AttestationContext {
  uid: Hex
  attester: Address
  data: Hex
  timestamp: number
  txHash: Hex
  // biome-ignore lint/suspicious/noExplicitAny: Ponder's generated db type is not exported
  db: any
}

/** Returns the need a community attestation belongs to, so the caller can still write a timeline row for it. */
export const recordCommunityAttestation = async (
  name: CommunitySchemaName,
  ctx: AttestationContext,
): Promise<bigint | null> => {
  if (name === 'WorkPhotos') {
    const [needId, photos, note] = decodeCommunityData<WorkPhotosData>('WorkPhotos', ctx.data)
    const need = await ctx.db.find(schema.need, { id: needId })
    // Only the NGO that owns the need can publish its work photos.
    if (!need || need.ngo.toLowerCase() !== ctx.attester.toLowerCase()) return null
    const usable = usablePhotos(photos)
    if (usable.length === 0) return null

    await ctx.db.insert(schema.workPhotos).values({
      uid: ctx.uid,
      needId,
      ngo: ctx.attester,
      photos: usable,
      note: trim(note, MAX_TEXT),
      revoked: false,
      timestamp: ctx.timestamp,
      txHash: ctx.txHash,
    })
    return needId
  }

  if (name === 'NeedPresentation') {
    const [needId, coverImage, gallery, summary, tags] = decodeCommunityData<NeedPresentationData>(
      'NeedPresentation',
      ctx.data,
    )
    const need = await ctx.db.find(schema.need, { id: needId })
    // Only the NGO that owns the need decides how it is presented.
    if (!need || need.ngo.toLowerCase() !== ctx.attester.toLowerCase()) return null

    const cover = usablePhotos([coverImage])[0] ?? ''
    const row = {
      uid: ctx.uid,
      ngo: ctx.attester,
      coverImage: cover,
      gallery: usablePhotos(gallery),
      summary: trim(summary, MAX_TEXT),
      tags: tags.slice(0, MAX_TAGS).map((tag) => trim(tag, MAX_TAG)),
      timestamp: ctx.timestamp,
    }
    // Publishing again replaces what donors see; the attestations remain as the history of what changed.
    await ctx.db.insert(schema.needPresentation).values({ needId, ...row }).onConflictDoUpdate(row)
    return needId
  }

  if (name === 'OrgTaxStatus') {
    const [org, jurisdiction, taxId, legalName, source] = decodeCommunityData<OrgTaxStatusData>(
      'OrgTaxStatus',
      ctx.data,
    )
    const isOrg = org.toLowerCase() === ctx.attester.toLowerCase()
    const isAdmin = ctx.attester.toLowerCase() === ADMIN
    // An organisation states its own standing; only the admin's signature marks it as checked.
    if (!isOrg && !isAdmin) return null

    const existing = await ctx.db.find(schema.orgTaxStatus, { org })
    if (isOrg) {
      const claim = {
        jurisdiction: trim(jurisdiction, MAX_TAG),
        taxId: trim(taxId, MAX_TAG),
        legalName: trim(legalName, MAX_TEXT),
        source: trim(source, MAX_URL),
        claimedAt: ctx.timestamp,
        claimUid: ctx.uid,
        revoked: false,
        // A restated claim is a new claim: whatever was checked before was checked against the old text.
        verifiedBy: null,
        verifiedSource: null,
        verifiedAt: null,
        verifiedUid: null,
      }
      await ctx.db.insert(schema.orgTaxStatus).values({ org, ...claim }).onConflictDoUpdate(claim)
      return null
    }
    // The admin can only confirm a claim the organisation actually made.
    if (!existing) return null
    await ctx.db.update(schema.orgTaxStatus, { org }).set({
      verifiedBy: ctx.attester,
      verifiedSource: trim(source, MAX_URL),
      verifiedAt: ctx.timestamp,
      verifiedUid: ctx.uid,
    })
    return null
  }

  if (name === 'DonationAcknowledged') {
    const [receiptId, needId, documentHash, statement] = decodeCommunityData<DonationAcknowledgedData>(
      'DonationAcknowledged',
      ctx.data,
    )
    const need = await ctx.db.find(schema.need, { id: needId })
    // Only the donee can acknowledge a donation to itself.
    if (!need || need.ngo.toLowerCase() !== ctx.attester.toLowerCase()) return null
    const receipt = await ctx.db.find(schema.receipt, { id: receiptId })
    if (!receipt || receipt.needId !== needId) return null

    const row = {
      needId,
      ngo: ctx.attester,
      documentHash,
      statement: trim(statement, MAX_STATEMENT),
      uid: ctx.uid,
      timestamp: ctx.timestamp,
      txHash: ctx.txHash,
    }
    await ctx.db.insert(schema.donationAcknowledgment).values({ receiptId, ...row }).onConflictDoUpdate(row)
    return needId
  }

  const [supplier, label, services, uri, credentialHash] = decodeCommunityData<SupplierApplicationData>(
    'SupplierApplication',
    ctx.data,
  )
  // An application is a request to register *yourself*: nobody applies on someone else's behalf.
  if (supplier.toLowerCase() !== ctx.attester.toLowerCase()) return null

  await ctx.db.insert(schema.supplierApplication).values({
    uid: ctx.uid,
    supplier,
    name: trim(label, MAX_TEXT),
    services: trim(services, MAX_TEXT),
    uri: trim(uri, MAX_URL),
    credentialHash,
    revoked: false,
    timestamp: ctx.timestamp,
    txHash: ctx.txHash,
  })
  return null
}

/** Revoking a community attestation withdraws it: the photos stop counting, the application stops showing. */
export const revokeCommunityAttestation = async (
  name: CommunitySchemaName,
  // biome-ignore lint/suspicious/noExplicitAny: Ponder's generated db type is not exported
  db: any,
  uid: Hex,
): Promise<void> => {
  // A presentation is replaced, not revoked: the row keeps whatever the NGO published last.
  if (name === 'NeedPresentation') return
  if (name === 'OrgTaxStatus') {
    const row = await db.sql
      .select()
      .from(schema.orgTaxStatus)
      .where(eq(schema.orgTaxStatus.claimUid, uid))
      .limit(1)
    if (row[0]) await db.update(schema.orgTaxStatus, { org: row[0].org }).set({ revoked: true })
    return
  }
  if (name === 'DonationAcknowledged') return
  const table = name === 'WorkPhotos' ? schema.workPhotos : schema.supplierApplication
  const row = await db.find(table, { uid })
  if (row) await db.update(table, { uid }).set({ revoked: true })
}
