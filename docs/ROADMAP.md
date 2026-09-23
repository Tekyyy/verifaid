# Roadmap

What this MVP deliberately does not do (spec §15), why, and what it would take. Each item names the weakness in
the current system that it closes — see `docs/THREAT_MODEL.md` for where those weaknesses bite.

## 1. Verifier staking and slashing

**Closes:** verifier–NGO collusion, the largest residual risk in the system. Today a dishonest verifier risks
only their reputation, and the NGO effectively chooses who reviews it.

**Shape:** verifiers bond stake in a `VerifierStaking` contract. A successful challenge slashes the signer of
the disputed attestation and pays part of the slash to the challenger, which also funds the watching that the
challenge window assumes. Needs draw verifiers from an eligible set by VRF rather than by NGO choice, so
collusion requires corrupting whoever is drawn.

**Prerequisites:** an appeal path that cannot be captured by the admin, and a slashing bar high enough to deter
without punishing honest disagreement. Getting this wrong is worse than not having it.

## 2. Upgradeable contracts behind a timelock

**Closes:** the fact that a bug today means redeploying and migrating open needs by hand.

**Shape:** UUPS proxies for `NeedsRegistry`, `DeliveryManager` and `BeneficiaryGroups`, with upgrades behind a
Safe plus a timelock long enough for donors to exit (refunds) before a change takes effect. Vaults stay
non-upgradeable on purpose: donors escrowed money under specific rules, and those rules should not be editable
after the fact.

## 3. Verifiable credentials for onboarding (W3C VC / EUDI wallet)

**Closes:** `credentialHash` currently commits to a document nobody can check on-chain — the admin vouches for
an NGO's legal registration by fiat.

**Shape:** NGOs and verifiers present a VC issued by a registry authority (a charity commission, a municipality,
an EUDI wallet attestation). `RoleRegistry` verifies the issuer's signature and the credential's status on
registration, and the admin's role shrinks from "decides who is real" to "decides which issuers count".

## 4. Restricted vouchers redeemable at approved merchants

**Closes:** the gap between "money reached the NGO" and "a household could actually buy food", and it removes
the need for a delivery photo in cash-based programmes.

**Shape:** a tranche mints restricted voucher tokens that only approved merchants can redeem, against the same
Semaphore identities. Redemption *is* the delivery confirmation, so the evidence step disappears for cash
programmes. Needs merchant onboarding and a settlement path, and careful thought about coercion: a voucher that
can be redeemed by anyone holding the card is as coercible as cash.

## 5. Live card on-ramp on mainnet

**Closes:** on Base Sepolia the "Pay by card" panel uses a mock on-ramp that mints test USDC, because the Coinbase
Onramp only delivers on mainnet. (The bank-partner path this item used to be about was removed in v7; money now
only arrives on chain, `docs/DECISIONS.md` §20.)

**Shape:** a mainnet deployment plus CDP credentials (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`) switch the panel to
the real Onramp session-token flow already built; nothing in the contracts changes.

## 6. ZK aggregate impact proofs and differential privacy

**Closes:** confirmation counts and coarse regions still leak a little, and small programmes leak more (§3.5 of
the threat model). The current mitigation is a blunt minimum of five expected recipients.

**Shape:** publish aggregate statistics with a proof that they were computed correctly over the real
confirmations, without publishing the per-delivery counts, plus calibrated noise on public breakdowns. That
would let a programme of eight households publish impact without publishing "eight".

## 7. From the proposal, deliberately deferred

The public proposal marks these as later phases; v2 does not build them (`docs/GAP_PLAN.md` item C3).

- **OfferBook.** Suppliers publish offers against open needs (price, delivery date, conditions) and the NGO picks
  one, so the `Settlement` attestation's supplier reference points at an on-chain offer instead of an invoice
  hash. v4 built the half this rests on — `SUPPLIER_ROLE` and vaults that pay registered suppliers directly, by a
  plan fixed at creation — so what is left is the offers themselves and a dispute path for undelivered ones.
  A plan change also has no cooling-off period today; an offer with a deadline is the natural place to add one.
- **ProtocolTreasury.** A transparent fee or donation stream that funds verifiers and relayers, with its own
  tranche-like release rules. Blocked on deciding who governs it; without that it is just an admin wallet.
- **Multichain.** Needs funded on several chains with one registry of record. The clean shape is one home chain
  for the registry and deliveries, with ledgers elsewhere reporting through a bridge or cross-chain attestations;
  it multiplies the trust surface, so it waits until a partner actually needs a second chain.
- **Real payment providers.** The checkout and CSV import are sandboxes. Moving to a licensed PSP (card) and a
  PSD2 / ISO 20022 bank feed means a provider onboarding flow, reconciliation reports signed by the provider, and
  refunds for off-chain needs executed by the provider and attested back.

## 8. Mainnet on Base

Everything above is a prerequisite for at least one of: a professional audit, a Safe multisig with a timelock
for the admin role, a KMS-backed key hierarchy for the services (today they can read the evidence they store),
a legal review of the crypto-shredding erasure story, and real custody arrangements for the stablecoin.

## Smaller things worth doing first

- **Batch and delay confirmation relaying** so submission order cannot be correlated with a queue at the
  distribution point. Cheap, and it closes a real timing leak.
- **Per-verifier envelope encryption of evidence** against verifier-held public keys, so the evidence service
  cannot read what it stores.
- **Committed Prisma migrations** instead of `db push`, once the schema stops moving.
- **A gas benchmark suite**, so a confirmation's cost per beneficiary is a number in CI rather than an assumption.
- ~~Partial refunds on under-funded needs that expire without reaching their target.~~ Done in v2: funding and
  execution deadlines, a minimum threshold with partial execution, and a permissionless `expire`.
