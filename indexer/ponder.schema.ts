import { index, onchainTable, primaryKey, relations } from 'ponder'

/**
 * Tables from spec §10, plus what the derived API routes need.
 *
 * Privacy rule (spec §8): only what is already public on-chain is stored here. Beneficiaries appear as
 * Semaphore identity commitments (unlinkable, and needed by the beneficiary page to rebuild the Merkle tree)
 * and as confirmation nullifiers and counts. Nothing else about a person is indexed.
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

/** Verifiers, bank partners and field agents. `ngo` is set only for field agents (they are bound to one NGO). */
export const roleAccount = onchainTable(
  'role_account',
  (t) => ({
    address: t.hex().primaryKey(),
    role: t.text().notNull(), // VERIFIER | BANK_PARTNER | FIELD_AGENT
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
    /** OnChain (AidVault escrow, Model B) | OffChain (payment provider custody, Model A). */
    custodyMode: t.text().notNull(),
    custodian: t.hex(),
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
    /** Fees intermediaries kept, as attested in FundingRecorded and Settlement. */
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
 * `donor` is set for direct donations, `donorRefHash` (salted, never the raw reference) for provider ones.
 * DIRECT: a wallet donated to the vault. FIAT: a provider deposited a card or bank payment into the vault.
 * OFFCHAIN: a provider holds the money and recorded it by attestation (non-custodial need).
 * CONVERTED: another token was swapped into the vault token on-chain, from a wallet or a deposit address. A deposit
 *   address that credits itself has no donor; its refund key is `donorRefHash` = the address padded to 32 bytes.
 */
export const donation = onchainTable(
  'donation',
  (t) => ({
    id: t.text().primaryKey(), // txHash-logIndex
    needId: t.bigint().notNull(),
    kind: t.text().notNull(), // DIRECT | FIAT | OFFCHAIN | CONVERTED
    donor: t.hex(),
    donorRefHash: t.hex(),
    paymentRefHash: t.hex(),
    /** Payment provider that deposited or recorded the donation. It is the intermediary, never the donor. */
    partner: t.hex(),
    /** Net amount: what counts toward the target. */
    amount: t.bigint().notNull(),
    /** What the donor paid and what the provider kept, once a FundingRecorded attestation states them. */
    gross: t.bigint(),
    fee: t.bigint(),
    currency: t.text(),
    receiptId: t.bigint(),
    attestationUID: t.hex(),
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
    refIdx: index().on(table.paymentRefHash),
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

/** A tranche payout reconciled by a Settlement attestation (NGO for on-chain custody, custodian for off-chain). */
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
    trancheIndex: t.integer().notNull(),
    fieldAgent: t.hex().notNull(),
    expectedRecipients: t.integer().notNull(),
    confirmations: t.integer().notNull(),
    status: t.text().notNull(),
    evidenceUID: t.hex(),
    evidenceCID: t.text(),
    evidenceHash: t.hex(),
    itemsDelivered: t.integer(),
    verifierUID: t.hex(),
    verifier: t.hex(),
    challengeDeadline: t.integer(),
    /** The challenge currently holding this delivery in `Disputed`, cleared when the admin resolves it. */
    activeChallengeId: t.text(),
    openedAt: t.integer().notNull(),
    finalizedAt: t.integer(),
  }),
  (table) => ({ needIdx: index().on(table.needId), statusIdx: index().on(table.status) }),
)

/**
 * An anonymous beneficiary confirmation. Only the Semaphore nullifier is recorded — it is public on-chain,
 * scoped to one delivery, and cannot be linked back to an identity or across deliveries.
 */
export const confirmation = onchainTable(
  'confirmation',
  (t) => ({
    id: t.text().primaryKey(), // deliveryId-nullifier
    deliveryId: t.bigint().notNull(),
    needId: t.bigint().notNull(),
    nullifier: t.bigint().notNull(),
    sequence: t.integer().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({ deliveryIdx: index().on(table.deliveryId) }),
)

export const challenge = onchainTable(
  'challenge',
  (t) => ({
    id: t.text().primaryKey(), // txHash-logIndex
    deliveryId: t.bigint().notNull(),
    needId: t.bigint().notNull(),
    challenger: t.hex().notNull(),
    reasonHash: t.hex().notNull(),
    upheld: t.boolean(),
    resolvedAt: t.integer(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({ deliveryIdx: index().on(table.deliveryId) }),
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
    deliveryId: t.bigint(),
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
    deliveryIdx: index().on(table.deliveryId),
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
  program: one(program, { fields: [need.programId], references: [program.id] }),
  organization: one(ngo, { fields: [need.ngo], references: [ngo.address] }),
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
  confirmations: many(confirmation),
  challenges: many(challenge),
}))

export const confirmationRelations = relations(confirmation, ({ one }) => ({
  delivery: one(delivery, { fields: [confirmation.deliveryId], references: [delivery.id] }),
}))

export const challengeRelations = relations(challenge, ({ one }) => ({
  delivery: one(delivery, { fields: [challenge.deliveryId], references: [delivery.id] }),
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
  delivery: one(delivery, { fields: [attestation.deliveryId], references: [delivery.id] }),
}))

export const impactReportRelations = relations(impactReport, ({ one }) => ({
  need: one(need, { fields: [impactReport.needId], references: [need.id] }),
}))

export const timelineEventRelations = relations(timelineEvent, ({ one }) => ({
  need: one(need, { fields: [timelineEvent.needId], references: [need.id] }),
}))
