import { index, onchainTable, primaryKey, relations } from 'ponder'

/**
 * Tables from spec §10, plus what the derived API routes need.
 *
 * Privacy rule (spec §8): only what is already public on-chain is stored here. Beneficiaries appear only as
 * Semaphore identity commitments enrolled in a programme (unlinkable). Donors appear as the wallets that gave
 * and, since v8, approved a delivery — both already public on chain. Nothing else about a person is indexed.
 *
 * Amounts are `bigint` (token base units), addresses and hashes are `hex`, enum-ish values are stored as the
 * same labels @poa/shared exposes so the API never has to translate numbers the UI would misread.
 */

// ─── organizations and roles ─────────────────────────────────────────────────

export const ngo = onchainTable('ngo', (t) => ({
  address: t.hex().primaryKey(),
  payout: t.hex().notNull(),
  credentialHash: t.hex().notNull(),
  metadataURI: t.text().notNull(),
  active: t.boolean().notNull(),
  registeredAt: t.integer().notNull(),
}))

/** Verifiers. `ngo` is unused since v8 (it bound field agents to their NGO) and stays null. */
export const roleAccount = onchainTable(
  'role_account',
  (t) => ({
    address: t.hex().primaryKey(),
    role: t.text().notNull(), // VERIFIER
    ngo: t.hex(),
    active: t.boolean().notNull(),
    registeredAt: t.integer().notNull(),
  }),
  (table) => ({ roleIdx: index().on(table.role) }),
)

/** Global pause flag: while paused the system can only be made safer, never moved forward (DECISIONS §4). */
export const systemState = onchainTable('system_state', (t) => ({
  chainId: t.integer().primaryKey(),
  paused: t.boolean().notNull(),
  updatedAt: t.integer().notNull(),
}))

// ─── programs and beneficiary groups ─────────────────────────────────────────

export const program = onchainTable(
  'program',
  (t) => ({
    id: t.bigint().primaryKey(),
    ngo: t.hex().notNull(),
    groupId: t.bigint().notNull(),
    enrollmentPolicyHash: t.hex().notNull(),
    metadataURI: t.text().notNull(),
    /** Live members, mirroring BeneficiaryGroups.memberCount (removals decrement it). */
    memberCount: t.integer().notNull(),
    /** Leaves inserted into the Semaphore tree, including the ones later zeroed out by a removal. */
    leafCount: t.integer().notNull(),
    merkleTreeRoot: t.bigint(),
    active: t.boolean().notNull(),
    createdAt: t.integer().notNull(),
  }),
  (table) => ({ groupIdx: index().on(table.groupId) }),
)

/**
 * Semaphore group id → program. Semaphore is a shared deployment on public chains, so its member events are
 * only indexed when the group appears here, i.e. when BeneficiaryGroups created it.
 */
export const semaphoreGroup = onchainTable('semaphore_group', (t) => ({
  groupId: t.bigint().primaryKey(),
  programId: t.bigint().notNull(),
}))

/**
 * One row per Semaphore leaf, keyed by its insertion index — the order that reproduces the Merkle root.
 * A removed member keeps its index with `commitment = 0`, exactly like the LeanIMT on-chain.
 */
export const programMember = onchainTable(
  'program_member',
  (t) => ({
    programId: t.bigint().notNull(),
    leafIndex: t.integer().notNull(),
    commitment: t.bigint().notNull(),
    removed: t.boolean().notNull(),
    addedAt: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.programId, table.leafIndex] }),
    programIdx: index().on(table.programId, table.leafIndex),
  }),
)

// ─── needs ───────────────────────────────────────────────────────────────────

export const need = onchainTable(
  'need',
  (t) => ({
    id: t.bigint().primaryKey(),
    ngo: t.hex().notNull(),
    programId: t.bigint().notNull(),
    category: t.hex().notNull(),
    regionCode: t.hex().notNull(),
    /** ISO 3166-1 country, the prefix of the ISO 3166-2 region ("ES" for "ES-CM"), for filtering. */
    country: t.text().notNull(),
    dossierHash: t.hex().notNull(),
    metadataURI: t.text().notNull(),
    targetAmount: t.bigint().notNull(),
    verificationsRequired: t.integer().notNull(),
    verificationCount: t.integer().notNull(),
    status: t.text().notNull(),
    /** The need's AidVault; null until it is verified. */
    vault: t.hex(),
    // ── the terms the NGO committed to at creation ──
    fundingDeadline: t.integer(),
    executionDeadline: t.integer(),
    minFundingBps: t.integer().notNull(),
    thirdPartyCostBps: t.integer().notNull(),
    expectedOutcomeHash: t.hex().notNull(),
    costDisclosureHash: t.hex(),
    // ── money ──
    totalDonated: t.bigint().notNull(),
    totalReleased: t.bigint().notNull(),
    totalRefunded: t.bigint().notNull(),
    // ── idle capital: what is lent, what it earned, and what it lost ──
    /** The ERC-4626 venue this need's escrow waits in, or null while it holds none. */
    yieldVenue: t.hex(),
    /** Whether the NGO opted this need in, which it could only do before the need could take a donation. */
    yieldEnabled: t.boolean().notNull(),
    /** Lent out right now, at cost. */
    deployedPrincipal: t.bigint().notNull(),
    /** Earned and brought home, handed on to the NGO, and principal a venue did not return. */
    yieldRealised: t.bigint().notNull(),
    yieldPaid: t.bigint().notNull(),
    yieldLost: t.bigint().notNull(),
    /** What intermediaries kept: conversion costs on the way in, Settlement-attested fees on the way out. */
    fundingFees: t.bigint().notNull(),
    settlementFees: t.bigint().notNull(),
    trancheCount: t.integer().notNull(),
    createdAt: t.integer().notNull(),
    createdTxHash: t.hex().notNull(),
    fundingClosedAt: t.integer(),
    completedAt: t.integer(),
    cancelledAt: t.integer(),
    expiredAt: t.integer(),
  }),
  (table) => ({
    statusIdx: index().on(table.status),
    categoryIdx: index().on(table.category),
    regionIdx: index().on(table.regionCode),
    countryIdx: index().on(table.country),
    ngoIdx: index().on(table.ngo),
    vaultIdx: index().on(table.vault),
  }),
)

export const tranche = onchainTable(
  'tranche',
  (t) => ({
    needId: t.bigint().notNull(),
    index: t.integer().notNull(),
    bps: t.integer().notNull(),
    amount: t.bigint().notNull(),
    status: t.text().notNull(),
    deliveryId: t.bigint(),
    releasedAt: t.integer(),
    releasedTo: t.hex(),
    releaseTxHash: t.hex(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.needId, table.index] }),
    needIdx: index().on(table.needId, table.index),
  }),
)

// ─── donations ───────────────────────────────────────────────────────────────

/**
 * `donor` is set whenever a wallet was credited, card donations included.
 * DIRECT: a wallet donated to the vault.
 * CONVERTED: another token was swapped into the vault token on-chain, from a wallet or a deposit address. A deposit
 *   address that credits itself has no donor; its refund key is `donorRefHash` = the address padded to 32 bytes.
 */
export const donation = onchainTable(
  'donation',
  (t) => ({
    id: t.text().primaryKey(), // txHash-logIndex
    needId: t.bigint().notNull(),
    kind: t.text().notNull(), // DIRECT | CONVERTED
    donor: t.hex(),
    /** Set when a deposit address holds the claim itself: its address, left-padded to 32 bytes. */
    donorRefHash: t.hex(),
    /** Net amount that still counts toward the target, i.e. given minus anything withdrawn. */
    amount: t.bigint().notNull(),
    /** Taken back by the donor while the need was still raising. The `Donated` event keeps the original. */
    withdrawn: t.bigint().notNull(),
    receiptId: t.bigint(),
    // ── CONVERTED only: the wallet or deposit address the swap ran for, and what it did ──
    via: t.hex(),
    viaDepositAddress: t.boolean(),
    /** Token given (zero address for ETH) and how much, in its own base units; set by the swap event. */
    tokenIn: t.hex(),
    amountIn: t.bigint(),
    /** Vault token the swap produced, and what the input was worth at Chainlink prices. */
    converted: t.bigint(),
    fairValue: t.bigint(),
    /** Fair value minus output, attributed to the donated part; the resolver counts it against the cost cap. */
    conversionFee: t.bigint(),
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    needIdx: index().on(table.needId),
    donorIdx: index().on(table.donor),
    viaIdx: index().on(table.via),
    txIdx: index().on(table.txHash),
  }),
)

/** Soulbound ERC-721 receipt, one per direct donation. */
export const receipt = onchainTable(
  'receipt',
  (t) => ({
    id: t.bigint().primaryKey(), // tokenId
    needId: t.bigint().notNull(),
    owner: t.hex().notNull(),
    amount: t.bigint().notNull(),
    donationId: t.text(),
    mintedAt: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ ownerIdx: index().on(table.owner), needIdx: index().on(table.needId) }),
)

/** Pro-rata refunds paid out after a need was cancelled (direct donors and, by reference, fiat donors). */
export const refund = onchainTable(
  'refund',
  (t) => ({
    id: t.text().primaryKey(), // txHash-logIndex
    needId: t.bigint().notNull(),
    account: t.hex(),
    donorRefHash: t.hex(),
    amount: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({ needIdx: index().on(table.needId), accountIdx: index().on(table.account) }),
)

// ─── payment plans (v4) ──────────────────────────────────────────────────────

/** A registered supplier (SUPPLIER_ROLE): a vetted service provider that vaults may pay directly. */
export const supplier = onchainTable('supplier', (t) => ({
  address: t.hex().primaryKey(),
  credentialHash: t.hex().notNull(),
  metadataURI: t.text().notNull(),
  active: t.boolean().notNull(),
  registeredAt: t.integer().notNull(),
  /** Everything vaults delivered to it (held payments count once they are claimed). */
  totalPaid: t.bigint().notNull(),
}))

/**
 * One payee of an on-chain need's payment plan, as committed in `NeedCreated` and updated by approved supplier
 * replacements. `account` is null for the NGO's own share, which the vault pays to its payout Safe.
 */
export const payee = onchainTable(
  'payee',
  (t) => ({
    needId: t.bigint().notNull(),
    index: t.integer().notNull(),
    account: t.hex(),
    label: t.text().notNull(),
    refHash: t.hex().notNull(),
    /** number[]: share of each tranche in basis points. */
    shareBps: t.json().notNull(),
    /** Share of the whole need in basis points. */
    needShareBps: t.integer().notNull(),
    paid: t.bigint().notNull(),
    held: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.needId, table.index] }),
    accountIdx: index().on(table.account),
  }),
)

/** A payment out of a vault to a payee of its plan, or one held because the token refused the transfer. */
export const payeePayment = onchainTable(
  'payee_payment',
  (t) => ({
    id: t.text().primaryKey(), // txHash-logIndex
    needId: t.bigint().notNull(),
    trancheIndex: t.integer().notNull(),
    payee: t.hex().notNull(),
    payeeIndex: t.integer(),
    toNgo: t.boolean().notNull(),
    amount: t.bigint().notNull(),
    held: t.boolean().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({ needIdx: index().on(table.needId), payeeIdx: index().on(table.payee) }),
)

/** A supplier replacement: proposed by the NGO, applied once enough independent verifiers approve it. */
export const payeeChange = onchainTable(
  'payee_change',
  (t) => ({
    changeId: t.bigint().primaryKey(),
    needId: t.bigint().notNull(),
    index: t.integer().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    label: t.text().notNull(),
    refHash: t.hex().notNull(),
    approvals: t.integer().notNull(),
    /** Address[] of the verifiers who approved it. */
    approvedBy: t.json().notNull(),
    status: t.text().notNull(), // PENDING | APPLIED | CANCELLED
    proposedAt: t.integer().notNull(),
    resolvedAt: t.integer(),
  }),
  (table) => ({ needIdx: index().on(table.needId) }),
)

// ─── deposit addresses ───────────────────────────────────────────────────────

/**
 * A DonationForwarder: an address a donor can send USDC or ETH to from an exchange. It commits to one need and
 * to where refunds go; anyone can sweep it into the vault. Rows appear on deployment (usually the first sweep).
 */
export const depositAddress = onchainTable(
  'deposit_address',
  (t) => ({
    address: t.hex().primaryKey(),
    needId: t.bigint().notNull(),
    receiptTo: t.hex(),
    refundTo: t.hex(),
    refundSigner: t.hex(),
    salt: t.hex().notNull(),
    deployedAt: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ needIdx: index().on(table.needId) }),
)

/** Money a deposit address sent back: undonated leftovers, or its vault refund after a cancellation or expiry. */
export const depositRefund = onchainTable(
  'deposit_refund',
  (t) => ({
    id: t.text().primaryKey(), // txHash-logIndex
    depositAddress: t.hex().notNull(),
    kind: t.text().notNull(), // LEFTOVER | VAULT
    token: t.hex(),
    to: t.hex().notNull(),
    amount: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({ depositIdx: index().on(table.depositAddress) }),
)

/** A tranche payout the NGO reconciled with a Settlement attestation. */
export const settlement = onchainTable(
  'settlement',
  (t) => ({
    uid: t.hex().primaryKey(),
    needId: t.bigint().notNull(),
    trancheIndex: t.integer().notNull(),
    attester: t.hex().notNull(),
    gross: t.bigint().notNull(),
    fee: t.bigint().notNull(),
    net: t.bigint().notNull(),
    supplierRefHash: t.hex().notNull(),
    fxRef: t.hex().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({ needIdx: index().on(table.needId, table.trancheIndex) }),
)

// ─── deliveries ──────────────────────────────────────────────────────────────

export const delivery = onchainTable(
  'delivery',
  (t) => ({
    id: t.bigint().primaryKey(),
    needId: t.bigint().notNull(),
    /** The tranche this evidence unlocks; it accounts for the one before it. */
    trancheIndex: t.integer().notNull(),
    submitter: t.hex().notNull(),
    /** Open (donors reviewing), Approved (tranche unlocked) or Superseded (the NGO filed newer evidence). */
    status: t.text().notNull(),
    evidenceHash: t.hex().notNull(),
    /** The manifest exactly as submitted; its keccak256 is `evidenceHash`. */
    manifest: t.text().notNull(),
    approvedAmount: t.bigint().notNull(),
    /** What the donors who approve must have given between them, read from the contract. */
    requiredAmount: t.bigint().notNull(),
    supersededBy: t.bigint(),
    submittedAt: t.integer().notNull(),
    approvedAt: t.integer(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ needIdx: index().on(table.needId), statusIdx: index().on(table.status) }),
)

/** A donor approving a delivery, with the weight of what they gave. */
export const deliveryApproval = onchainTable(
  'delivery_approval',
  (t) => ({
    id: t.text().primaryKey(), // deliveryId-donor
    deliveryId: t.bigint().notNull(),
    needId: t.bigint().notNull(),
    donor: t.hex().notNull(),
    weight: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({ deliveryIdx: index().on(table.deliveryId), donorIdx: index().on(table.donor) }),
)

// ─── attestations ────────────────────────────────────────────────────────────

export const attestation = onchainTable(
  'attestation',
  (t) => ({
    uid: t.hex().primaryKey(),
    schemaUID: t.hex().notNull(),
    schemaName: t.text().notNull(),
    attester: t.hex().notNull(),
    recipient: t.hex().notNull(),
    refUID: t.hex(),
    needId: t.bigint(),
    /** The schema payload decoded with @poa/shared's schema definitions; bigints already stringified. */
    decoded: t.json().notNull(),
    revoked: t.boolean().notNull(),
    revokedAt: t.integer(),
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    needIdx: index().on(table.needId),
    schemaIdx: index().on(table.schemaName),
  }),
)

/** One row per need; `revoked` reports are excluded from the impact totals but kept for the audit trail. */
export const impactReport = onchainTable(
  'impact_report',
  (t) => ({
    uid: t.hex().primaryKey(),
    needId: t.bigint().notNull(),
    beneficiariesServed: t.integer().notNull(),
    kpiHash: t.hex().notNull(),
    reportCID: t.text().notNull(),
    revoked: t.boolean().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({ needIdx: index().on(table.needId) }),
)

// ─── timeline ────────────────────────────────────────────────────────────────

/**
 * Denormalized, append-only story of one need. Every state change in the system writes exactly one row here,
 * so `/needs/:id/timeline` is a single ordered read (block number, then log index).
 */
export const timelineEvent = onchainTable(
  'timeline_event',
  (t) => ({
    id: t.text().primaryKey(), // txHash-logIndex
    needId: t.bigint().notNull(),
    type: t.text().notNull(),
    data: t.json().notNull(),
    attestationUID: t.hex(),
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    needIdx: index().on(table.needId, table.blockNumber, table.logIndex),
    orderIdx: index().on(table.blockNumber, table.logIndex),
  }),
)

// ─── relations (for the GraphQL schema) ──────────────────────────────────────

export const needRelations = relations(need, ({ many, one }) => ({
  tranches: many(tranche),
  donations: many(donation),
  settlements: many(settlement),
  deliveries: many(delivery),
  attestations: many(attestation),
  timeline: many(timelineEvent),
  payees: many(payee),
  payments: many(payeePayment),
  payeeChanges: many(payeeChange),
  program: one(program, { fields: [need.programId], references: [program.id] }),
  organization: one(ngo, { fields: [need.ngo], references: [ngo.address] }),
}))

export const payeeRelations = relations(payee, ({ one }) => ({
  need: one(need, { fields: [payee.needId], references: [need.id] }),
}))

export const payeePaymentRelations = relations(payeePayment, ({ one }) => ({
  need: one(need, { fields: [payeePayment.needId], references: [need.id] }),
}))

export const payeeChangeRelations = relations(payeeChange, ({ one }) => ({
  need: one(need, { fields: [payeeChange.needId], references: [need.id] }),
}))

export const trancheRelations = relations(tranche, ({ one }) => ({
  need: one(need, { fields: [tranche.needId], references: [need.id] }),
}))

export const donationRelations = relations(donation, ({ one }) => ({
  need: one(need, { fields: [donation.needId], references: [need.id] }),
  receipt: one(receipt, { fields: [donation.receiptId], references: [receipt.id] }),
}))

export const depositAddressRelations = relations(depositAddress, ({ many, one }) => ({
  need: one(need, { fields: [depositAddress.needId], references: [need.id] }),
  refunds: many(depositRefund),
}))

export const depositRefundRelations = relations(depositRefund, ({ one }) => ({
  depositAddress: one(depositAddress, {
    fields: [depositRefund.depositAddress],
    references: [depositAddress.address],
  }),
}))

export const settlementRelations = relations(settlement, ({ one }) => ({
  need: one(need, { fields: [settlement.needId], references: [need.id] }),
}))

export const receiptRelations = relations(receipt, ({ one }) => ({
  need: one(need, { fields: [receipt.needId], references: [need.id] }),
}))

export const deliveryRelations = relations(delivery, ({ many, one }) => ({
  need: one(need, { fields: [delivery.needId], references: [need.id] }),
  approvals: many(deliveryApproval),
}))

export const deliveryApprovalRelations = relations(deliveryApproval, ({ one }) => ({
  delivery: one(delivery, { fields: [deliveryApproval.deliveryId], references: [delivery.id] }),
}))

/** Photos of finished work, published by the NGO that ran the need (resolver-less `WorkPhotos` schema). */
export const workPhotos = onchainTable(
  'work_photos',
  (t) => ({
    uid: t.hex().primaryKey(),
    needId: t.bigint().notNull(),
    ngo: t.hex().notNull(),
    /** string[]: image URLs, https or ipfs, capped when indexed. */
    photos: t.json().notNull(),
    note: t.text().notNull(),
    revoked: t.boolean().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ needIdx: index().on(table.needId) }),
)

/**
 * How an NGO presents a need to donors (resolver-less `NeedPresentation` schema): a cover image, a gallery, a
 * summary and tags. One row per need — publishing again replaces it, so a presentation can be corrected.
 */
export const needPresentation = onchainTable('need_presentation', (t) => ({
  needId: t.bigint().primaryKey(),
  uid: t.hex().notNull(),
  ngo: t.hex().notNull(),
  coverImage: t.text().notNull(),
  /** string[]: further images. */
  gallery: t.json().notNull(),
  summary: t.text().notNull(),
  /** string[]: short labels an NGO chose, shown on the need's card. */
  tags: t.json().notNull(),
  timestamp: t.integer().notNull(),
}))

/**
 * What an organisation says about its tax standing, and whether the platform admin checked it. One row per
 * organisation: the organisation's own attestation fills the claim, the admin's fills the verification.
 */
export const orgTaxStatus = onchainTable('org_tax_status', (t) => ({
  org: t.hex().primaryKey(),
  jurisdiction: t.text().notNull(),
  taxId: t.text().notNull(),
  legalName: t.text().notNull(),
  /** Where the claim points: a determination letter, a register entry. */
  source: t.text().notNull(),
  claimedAt: t.integer().notNull(),
  claimUid: t.hex().notNull(),
  /** Set only by an attestation from the platform admin, which is what "verified" means here. */
  verifiedBy: t.hex(),
  verifiedSource: t.text(),
  verifiedAt: t.integer(),
  verifiedUid: t.hex(),
  revoked: t.boolean().notNull(),
}))

/** The donee acknowledging one donation: what a US donor needs to hold for a contribution of $250 or more. */
export const donationAcknowledgment = onchainTable('donation_acknowledgment', (t) => ({
  receiptId: t.bigint().primaryKey(),
  needId: t.bigint().notNull(),
  ngo: t.hex().notNull(),
  documentHash: t.hex().notNull(),
  statement: t.text().notNull(),
  uid: t.hex().notNull(),
  timestamp: t.integer().notNull(),
  txHash: t.hex().notNull(),
}))

/** A supplier asking an admin to register it (resolver-less `SupplierApplication` schema). A request, not a role. */
export const supplierApplication = onchainTable(
  'supplier_application',
  (t) => ({
    uid: t.hex().primaryKey(),
    supplier: t.hex().notNull(),
    name: t.text().notNull(),
    services: t.text().notNull(),
    uri: t.text().notNull(),
    credentialHash: t.hex().notNull(),
    revoked: t.boolean().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ supplierIdx: index().on(table.supplier) }),
)

export const workPhotosRelations = relations(workPhotos, ({ one }) => ({
  need: one(need, { fields: [workPhotos.needId], references: [need.id] }),
}))

export const programRelations = relations(program, ({ many }) => ({
  members: many(programMember),
  needs: many(need),
}))

export const programMemberRelations = relations(programMember, ({ one }) => ({
  program: one(program, { fields: [programMember.programId], references: [program.id] }),
}))

export const attestationRelations = relations(attestation, ({ one }) => ({
  need: one(need, { fields: [attestation.needId], references: [need.id] }),
}))

export const impactReportRelations = relations(impactReport, ({ one }) => ({
  need: one(need, { fields: [impactReport.needId], references: [need.id] }),
}))

export const timelineEventRelations = relations(timelineEvent, ({ one }) => ({
  need: one(need, { fields: [timelineEvent.needId], references: [need.id] }),
}))
