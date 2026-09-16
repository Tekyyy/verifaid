# Threat model

What this system defends, what it does not, and what is left over. Written to be read by a sceptic: the honest
answer to "does this stop fraud?" is *no system does* — this one makes specific claims falsifiable and specific
frauds expensive.

---

## 1. What we are protecting

| Asset | Why it matters | Where it lives |
|---|---|---|
| Donor funds | The obvious one: money in escrow that has not been spent yet | `AidVault` (stablecoin), or a payment provider for off-chain custody |
| Beneficiary identity and personal data | People receiving aid are often at risk from the same actors that caused the crisis | PII vault (encrypted), never on-chain |
| The link "this person received aid" | Even without a name, a linkable confirmation can expose someone | Semaphore nullifiers only |
| Evidence integrity | The claim "we delivered 120 kits" must be anchored in time | IPFS ciphertext + on-chain hash |
| The verification record | Who said a need was real, who signed off on a delivery | EAS attestations |
| Role assignments | Whoever controls roles controls the flow of money | `RoleRegistry` |

## 2. Trust assumptions

Stated plainly, because most of the security rests on them:

1. **The platform admin key is honest-ish and safe.** It can pause the system, cancel needs, resolve disputes and
   register organizations. It **cannot** move money out of a vault: there is no admin withdrawal path, and
   releases only ever go to an NGO's registered payout address. In production the admin is a Safe multisig.
2. **Verifiers are independent of the NGO they verify.** This is enforced structurally (§4) rather than assumed.
3. **At least one honest verifier watches each delivery.** The challenge window is only useful if somebody looks.
4. **The NGO's enrollment process is honest.** Nothing on-chain can tell a real household from an invented one.
5. **The stablecoin behaves like a standard ERC-20** and holds its peg.
7. **For off-chain custody (Model A), the named custodian is a regulated payment provider that really holds and
   pays out the money it attests.** The chain enforces who may attest and what the numbers must add up to; it
   cannot see a bank account. See §3.11.
6. **Beneficiaries' identity secrets stay on their own device** (phone mode). Card mode weakens this deliberately.

## 3. Threats and mitigations

### 3.1 Fake or inflated needs

*An NGO invents a need, or inflates a real one, to attract donations.*

- **Mitigation.** A need can only start collecting money after `verificationsRequired` independent verifiers
  attest to it on-chain, against the exact `dossierHash` of the assessment they read. Above
  `HIGH_VALUE_THRESHOLD` at least two are required. A single rejection cancels the need.
- **Structural independence.** `RoleRegistry` enforces one operational role per address and rejects a verifier
  that is the NGO, one of its field agents, or its payout Safe. So "independence" is not a policy sentence, it
  is a precondition the contract checks on every attestation.
- **Residual risk.** Verifier–NGO collusion off-chain. The verifier's name is permanently attached to the
  attestation, which is a reputational deterrent, not a technical one. Roadmap: verifier staking with slashing,
  and random assignment of verifiers to needs so an NGO cannot choose its own reviewer.

### 3.2 Money leaving without delivery

*Funds are released although nothing was delivered.*

- **Mitigation.** Only tranche 0 (pre-financing, a deliberate design choice so NGOs can actually buy goods) is
  released without evidence. Every later tranche requires **three independent signals**: evidence attested by
  the field agent, anonymous confirmations from at least `confirmationThresholdBps` of the expected recipients,
  and an approving attestation from an independent verifier — followed by a challenge window in which any other
  independent verifier can freeze it.
- **No path around it.** `AidVault.markReleasable` is callable only by the `DeliveryManager`, which only calls it
  from `finalize`, which requires `Challengeable` status and an elapsed deadline. Releases pay the registered
  payout address; the amount comes from the tranche plan fixed when funding closed.
- **Residual risk.** The first tranche is unproven by construction. Keep it small for unfamiliar partners —
  the tranche plan is per need, and a 10/45/45 split is as valid as 30/40/30.

### 3.3 Fabricated evidence

*Photos and manifests that do not correspond to a real distribution.*

- **Mitigation.** Hash anchoring proves the evidence existed at a point in time and has not changed since; the
  verifier reviews the decrypted bundle; the challenge window lets a second verifier object; the region in the
  evidence must match the need's region.
- **Residual risk.** **Hashing proves integrity, not truth.** A staged photo hashes just as well as a real one.
  This is the single most important thing to say out loud to judges. The defence is the combination with
  *beneficiary confirmations*, which are hard to fake at scale without real people, and with a verifier who is
  not paid by the NGO.

### 3.4 Double claiming and inflated confirmation counts

*The same person confirms twice; or the NGO manufactures confirmations.*

- **Mitigation.** Semaphore nullifiers are scoped to the delivery (`scope = deliveryId`), so one identity can
  confirm each delivery exactly once — enforced by the Semaphore contract, not by us. Confirmations are capped
  at `expectedRecipients`, and `expectedRecipients` may not exceed the program's enrolled member count.
- **Residual risk.** Sybil enrollment: an NGO that enrols 200 fake identities can produce 200 real proofs. This
  is a human problem and is where verifier sampling of the enrollment register matters. `enrollmentPolicyHash`
  commits publicly to the eligibility rules so an auditor can check the process that was promised.

### 3.5 De-anonymizing beneficiaries

*Working out who received aid from public data.*

- **Mitigation.** No personal data, no GPS, no photos and no unsalted hashes of personal data ever reach the
  chain. Beneficiaries appear only as Poseidon identity commitments. A confirmation emits a nullifier and a
  counter. Regions are coarse ISO 3166-2 subdivisions. Deliveries with fewer than `MIN_EXPECTED_RECIPIENTS`
  (5) expected recipients are refused, so a count cannot point at one household. Confirmations are relayed, so
  the beneficiary's own wallet never appears in a transaction — without this, the ZK proof would be pointless.
- **Residual risk.** *Timing correlation.* If a kiosk submits confirmations one at a time in the order people
  queue, an observer who watches the queue and the chain can link them. Mitigations: batch submissions, random
  delays, and a shared relayer across deliveries. *Small groups.* A programme with six members in one village
  is barely anonymous whatever the contract enforces. *The relayer sees the submission order* and must be
  treated as a semi-trusted party; it never learns identities, only nullifiers.

### 3.6 Coercion

*Someone forces a beneficiary to hand over aid, or to confirm receipt they never got.*

- **Partial mitigation.** Confirmations are anonymous, so a coercer cannot verify from public data whether a
  specific person confirmed. Card mode on a verifier-operated kiosk removes the phone requirement.
- **Residual risk.** **Not solvable technically.** A coercer standing next to the beneficiary sees the screen.
  This is a programme-design problem (distribution points, staff presence), and we should not pretend otherwise.

### 3.7 Fund theft and key compromise

- **Mitigation.** No admin withdrawal path exists. `ReentrancyGuard` on every value-moving function, strict CEI,
  and a fuzz-and-invariant-tested accounting identity
  (`balance + released + refunded == donated`). Releases go only to the payout address recorded at registration;
  there is deliberately no setter for it, so a compromised admin key cannot redirect future tranches.
- **If the admin key is compromised:** the attacker can pause the system, cancel needs (which triggers refunds to
  donors, not to the attacker), resolve disputes and register bogus organizations. They cannot take custody of
  escrowed funds. On testnet the admin is an EOA; anything beyond that should be a Safe multisig with a timelock.
- **If an NGO key is compromised:** the attacker can create needs and close funding, but money still only moves
  to the NGO's payout Safe, and only through verified deliveries. The admin can deactivate the NGO, which blocks
  further releases immediately.
- **If a verifier key is compromised:** the attacker can approve deliveries for any NGO. This is why a rejection
  is final for needs, why any *other* verifier can challenge a delivery, and why high-value needs need two.

### 3.8 Attestation-layer attacks

- **Schema squatting.** Anyone can register a schema in EAS pointing at one of our resolvers. Each resolver
  therefore derives the UID of the one schema it serves from its own address and rejects everything else, so a
  squatted schema cannot drive core state or slip past an indexer that filters on the five official UIDs.
- **Attestations to people.** Resolvers require `recipient` to be the expected contract, never an arbitrary
  address, so the attestation graph cannot be used as a back door for publishing data about a person.
- **Expiring attestations.** Rejected: an attestation that silently expires while still counted would be
  misleading.
- **Evidence chain forgery.** `DeliveryVerified.refUID` must equal the delivery's evidence UID, and
  `ImpactReport.refUID` must equal the `DeliveryVerified` UID of the last finalized delivery. An impact report
  for a need with no verified delivery cannot be published at all.

### 3.9 Bank-partner and fiat path

- **Mitigation.** `donateOnBehalf` is restricted to `BANK_PARTNER_ROLE`; a provider's payment reference can be
  consumed once system-wide (enforced in the factory, not just per vault, and scoped per provider so one
  provider cannot squat another's), so a transfer cannot fund two needs; a `FundingRecorded` attestation for an
  on-chain need is only accepted if it matches a deposit already recorded in the vault, with the same amount,
  provider and donor reference. Refunds for a fiat donor can only be triggered by the provider that deposited
  them. Fees the provider reports count against the need's disclosed cost cap.
- **Privacy.** Only salted hashes reach the chain: `keccak256(abi.encode(partnerSalt, endToEndId))`. A donor who
  knows their own reference can verify their donation; an observer cannot enumerate donors.
- **Residual risk.** The partner is trusted to actually have received the fiat. This is a regulated-entity
  assumption, not a cryptographic one.

### 3.11 Off-chain custody (Model A)

- **Threat.** A need's money never touches the chain, so a dishonest provider could record payments it did not
  receive (inflating "funded"), or report paying out tranches it kept.
- **Mitigation.** The NGO names one custodian when it creates the need, and only that provider can record funding
  or report payouts: another provider cannot adopt the need or release its tranches (review finding F1). Every
  record is an irrevocable, attributable attestation with a salted payment reference the provider can be audited
  against; payouts carry a supplier reference and an FX reference; fees are capped cumulatively by the need's
  disclosure. Tranches still only unlock through the three-signal delivery gate, so a provider that over-reports
  funding cannot move a need past a delivery nobody confirmed.
- **Residual risk.** This is a regulated-entity trust assumption, the same one the proposal accepts for its first
  phase. What the chain adds is that a lie is signed, dated and specific: an auditor comparing the provider's
  books to its attestations finds the discrepancy line by line. A custodian that stops reporting cannot block
  refunds forever: after the execution deadline and a 14-day grace period anyone can expire the need.

### 3.12 Deadlines and expiry

- **Threat.** `expire` is permissionless, so a donor-hostile actor could try to expire a need that had actually
  delivered, and an NGO could try to keep a failed need alive.
- **Mitigation.** A need cannot be verified or funded once either deadline has passed. After the execution
  deadline, a tranche already earned (releasable) or a verified delivery still in its challenge window or under
  dispute holds expiry off for `EXPIRY_GRACE_PERIOD`, and dismissing a challenge resumes the remaining window
  rather than restarting it (review finding F2). The hold is bounded, so nothing can postpone refunds
  indefinitely (F3).
- **Residual risk.** An NGO can donate to its own need to cross an all-or-nothing threshold (F5). This adds no
  exposure beyond pre-financing: an NGO that takes tranche 0 and does not deliver could do the same without the
  top-up. Enrolment vetting and verification of the NGO are the defence, not the threshold.

### 3.13 Public tracking, alerts and webhooks

- **Tracking references** are a receipt id or a salted payment reference hash: knowing one reveals a donation's
  amount and progress, both already public on-chain, and nothing about the donor.
- **Alert email addresses** are envelope-encrypted in the notifier and crypto-shredded on unsubscribe; the
  unsubscribe token is stored only as a hash. RSS and webhooks carry no personal data at all.
- **Outbound webhooks** are HMAC-signed so receivers can reject forgeries. Subscriber-supplied URLs are an SSRF
  vector; the notifier requires https and refuses private and link-local address literals outside development.
  DNS rebinding to a private address is not covered and belongs in the egress proxy of a production deployment.

### 3.10 GDPR versus immutability

- **Mitigation.** Personal data is only ever in the PII vault, encrypted with a per-record data key. Erasure is
  crypto-shredding: destroy the wrapped data key and the ciphertext is unrecoverable, then call `removeMember`
  so the identity can no longer confirm. What stays on-chain is an unlinkable commitment that is meaningless
  without a secret only the person held.
- **Residual risk.** Semaphore keeps old Merkle roots valid for a grace window (one hour by default), so a proof
  made just before removal can still be submitted inside that window — demonstrated in
  `test/integration/RealSemaphore.t.sol`. A legal review is required before any production deployment; nothing
  here constitutes advice that the design is GDPR-compliant.

## 4. What an outside observer can learn

Everything on-chain is public. Concretely, an observer sees: which NGOs exist and their public profiles; which
needs exist, their category, coarse region, target and tranche plan; who verified what; every donation amount
and the donor's address (for crypto donors — fiat donors appear only as a salted hash); when tranches were
released and to which payout address; how many people were expected at each delivery and how many confirmed; the
nullifiers of those confirmations; and the CIDs and hashes of encrypted evidence.

They cannot learn: who any beneficiary is, which beneficiary confirmed which delivery, what the evidence shows,
or what the needs assessment says.

**Cross-programme linkage is a real caveat, and it depends on the client.** Semaphore's duplicate-leaf check is
per group, so nothing on-chain stops the *same* identity commitment being enrolled in two programmes — and
Semaphore publishes every commitment it adds. If a beneficiary used one identity everywhere, intersecting two
groups' commitment sets would reveal exactly which people appear in both, and the programmes' public metadata
often says which villages or NGOs those are. The beneficiary app therefore derives a **separate identity per
programme** from the device secret, so the commitments a person presents to two programmes are unlinkable. An
NGO that enrols commitments from somewhere else can reintroduce the leak; enrolment tooling should refuse a
commitment that already appears in another of its programmes. (The confirmation layer itself is unaffected:
nullifiers are scoped per delivery, so two confirmations by the same person are never linkable.)

## 5. Denial of service and griefing

| Vector | Handling |
|---|---|
| A verifier repeatedly challenges a delivery | One challenge per verifier per delivery; the admin resolves and can reject the challenge |
| Donations blocking a need | Overfunding reverts, so a donor cannot push a need past its target to jam it |
| Blocking expiry | A releasable tranche or an in-flight delivery holds expiry off for at most 14 days after the execution deadline |
| Frivolous late challenges | Each verifier challenges once; a dismissed challenge resumes the remaining window instead of restarting it |
| Spam needs | Only registered, active NGOs can create needs; the admin can deactivate an NGO |
| Confirmation spam | Proofs must verify against the group and be unique per delivery; invalid proofs revert and cost the relayer gas — rate limiting belongs in the relayer |
| Griefing the relayer | The relayer pays gas for beneficiaries; rate limit per delivery and cap spend. This is an operational cost, not a contract vulnerability |

## 6. Known limitations

1. Contracts are **not upgradeable** and **not audited**. This is a hackathon MVP.
2. The admin is a single EOA on testnet.
3. Evidence keys are held by the services (a custodial KMS model). A production system should use envelope
   encryption against verifier-held public keys so the service operator cannot read evidence at all.
4. The relayer sees which delivery a confirmation belongs to and when it arrived.
5. Fee-on-transfer or rebasing tokens are not supported.
7. Off-chain custody is only as honest as its custodian (§3.11); the checkout, CSV import and settlement endpoints
   of the bank connector are a sandbox, not a payment integration.
6. Floor rounding leaves at most a few base units of dust in a vault after refunds.
