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

## 5. Real banking integration (PSD2 / ISO 20022)

**Closes:** the bank partner is currently trusted to have actually received the fiat — the mock webhook asserts
it.

**Shape:** the connector consumes signed PSD2 account-information feeds and reconciles `endToEndId` against real
`camt.053` statements before depositing on-chain. The salted-reference design already matches ISO 20022 fields,
so this is an integration problem rather than a redesign.

## 6. ZK aggregate impact proofs and differential privacy

**Closes:** confirmation counts and coarse regions still leak a little, and small programmes leak more (§3.5 of
the threat model). The current mitigation is a blunt minimum of five expected recipients.

**Shape:** publish aggregate statistics with a proof that they were computed correctly over the real
confirmations, without publishing the per-delivery counts, plus calibrated noise on public breakdowns. That
would let a programme of eight households publish impact without publishing "eight".

## 7. Mainnet on Base

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
- **Partial refunds on under-funded needs** that expire without reaching their target: today the NGO closes
  funding early or the admin cancels, and both are manual.
