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

### 3.9 Bank-partner and fiat path (retired in v7)

Kept as a record of what v2–v6 defended. Since v7 the contracts have no bank-partner role and no
`donateOnBehalf`, so none of the attacks below has an entry point; see §3.19 and `docs/DECISIONS.md` §20.

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

### 3.11 Off-chain custody (Model A, retired in v7)

Kept as a record of what v2–v6 defended. Since v7 every need is escrowed in its own vault and there is no
custodian to trust.

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

### 3.14 Conversions: oracles, DEX pools, the on-ramp and deposit addresses (v3)

- **Threat: extracting value from the swap.** A sandwich, a manipulated or drained pool, or a caller-chosen path
  could turn a 1,000 USDC donation into far less EURC.
- **Mitigation.** The caller chooses neither the path nor the minimum output. Routes are fixed by the admin and
  may only pass through USDC or WETH, and the router requires at least the Chainlink fair value minus the route's
  bound (1% for USDC and 1.5% for ETH as deployed, 5% hard cap), measuring what actually arrived. Only what the need
  can take is converted. A deposit address can only be swept by its donor or the platform's keeper, so nobody can
  wrap a sweep between two swaps of their own in one transaction; Base has no public mempool for the rest. What a
  swap did cost is recorded per donation and counted against the need's disclosed cost cap.
- **Residual risk.** Within the bound, a pool manipulated before an honest sweep or wallet donation still fills it
  at the bottom of the bound; the cost is visible and capped. Oracle error adds to the bound: EURC is priced at the
  EUR/USD feed, and feeds only update past their deviation threshold or heartbeat.
- **Threat: a compromised admin key** repricing or rerouting conversions (review finding 1).
- **Mitigation.** Replacing a feed or a route, loosening a bound or removing the sequencer check is scheduled and
  only executable two days later, in public (`ConfigChangeScheduled`), so donors can take waiting money back.
- **Threat: a wrong price.** A stale feed, a feed paused over a forex weekend, or an L2 sequencer outage during
  which prices cannot update.
- **Mitigation.** Per-feed heartbeats, rejection of non-positive, zero-time and future-dated answers, and on
  mainnet the sequencer uptime feed with a one-hour grace period after restart. All of these fail closed: the
  donation reverts and the donor keeps their tokens.
- **Threat: the stablecoins themselves.** Circle can blacklist an address or pause USDC or EURC, and a depeg moves
  the value of what the vault holds.
- **Residual risk.** A blacklisted vault cannot pay out or refund; a paused token stops every conversion. These are
  issuer risks of any stablecoin escrow. The oracle bound prices USDC at its own USD feed, so a USDC depeg lowers
  what a USDC donation converts to rather than being hidden.
- **Threat: the on-ramp.** Coinbase could refuse, delay or reverse a card purchase.
- **Mitigation.** The on-ramp delivers to the donor's own wallet, never to the platform, so nothing the platform
  holds depends on Coinbase settling. Until the donor taps "donate" the USDC is simply theirs. The donation itself
  is an ordinary on-chain transaction: once it is mined, no chargeback can reach the vault.
- **Threat: deposit addresses.** Funds sent to the wrong network or in an unsupported token, a sweep front-run
  into a bad state, a relayer that never sweeps, or a need that stops accepting while money sits unswept.
- **Mitigation.** The address commits to its need and refund route at creation (CREATE2 over the intent), so
  nobody can deploy it with other terms. Sweeping is permissionless and only ever donates to the committed need or
  returns money to the committed refund address. Unswept funds can be taken back by the donor at any time, and
  sent home by anyone once the need stops accepting. The refund key is generated and kept in the donor's browser.
- **Residual risk.** Tokens other than the accepted ones, or funds sent on another chain, are not recoverable by
  the contracts; the app warns before showing the address. If the keeper stops sweeping, deposits wait (the donor
  can sweep or take them back). Vault refunds are paid in EURC even when the donation arrived as USDC. Anyone can
  create a deposit address whose receipt goes to someone else's wallet, which publicly links that wallet to a need
  without giving it any rights.
- **Test networks.** On Base Sepolia the vault token, USDC and EUR/USD are mocks and the only liquid pool is ours;
  anyone can mint the mocks and move that pool, which makes donations revert until it is rebalanced. That is a
  testnet liveness issue, not a mainnet one: on mainnet the pools are Circle's tokens and Uniswap's deep markets.

### 3.15 Payment plans and suppliers (v4)

*The NGO pays itself, or pays a "supplier" it controls; or a supplier is paid for work it did not do; or money
gets stuck between the two.*

- **Mitigation.** An on-chain need's money leaves its vault only to the payees fixed in its plan at creation and
  verified with the need. Payees are addresses the admin registered as suppliers; the NGO can only appear as the
  plan's explicit sentinel, capped at 25% of the need. `RoleRegistry` refuses any address that holds — or ever
  held — another operational role, so an NGO's own field agent or payout Safe cannot be re-introduced as a
  supplier. Replacing a payee takes the NGO plus at least two independent verifiers, cannot redirect a tranche
  that is already releasable, and is public (`PayeeChangeProposed` / `PayeeChanged`).
- **Stuck money.** A transfer the stablecoin refuses is held for its payee and can be delivered by anyone later,
  or moved to an approved replacement; a need that still owes one is not reported Completed. On-chain custody
  always has an execution deadline, so `expire` and pro-rata refunds are always reachable without an admin.
- **Residual risk.** "Independent supplier" is an admin judgement made off-chain against a credential hash; the
  chain enforces separation of addresses, not of interests. A change takes effect as soon as the approvals are
  in, with no window for donors to leave first. And a plan can still be changed while the need is Pending, so an
  integrator must follow `PayeeChanged` rather than read the plan out of `NeedCreated` alone.

### 3.16 Taking a donation back (v5)

*A donor withdraws to sabotage a need, or to dodge a cost the NGO disclosed.*

- **Mitigation.** Withdrawals are possible only while the need is still raising, only for the wallet that holds
  the receipt, and never inside the two days before the funding deadline — so an NGO's go/no-go decision is made
  on a number that can no longer move. The vault re-checks the disclosed cost cap against the post-withdrawal
  total and refuses a withdrawal that would push recorded costs over it.
- **Residual risk.** A donor can still lower a need's raise at any earlier point, which is the price of letting
  people change their mind; an NGO that needs certainty earlier can close funding as soon as it is above its
  minimum, which locks both sides at once. And a withdrawal is public — it shows up on the need's timeline and
  on the donation, so a coordinated pull-out is visible rather than silent.

### 3.17 Tax receipts (v5 app)

*A donor's identity leaks through the paperwork, or an organisation claims a standing it does not have.*

- **Mitigation.** The receipt document is rendered in the donor's own browser; their name and address are never
  transmitted or stored, and the on-chain acknowledgment deliberately commits nothing about the donor — it is a
  statement about the donation. An organisation's tax claim is separated from its verification by *who signed
  it*: a claim is the organisation's own attestation, a verification is the platform admin's, recorded with the
  register they checked and the date.
- **Residual risk.** A verification is only as good as the admin's diligence, and a donor could still be
  identified by correlating a public donation with an off-chain disclosure they make themselves. Nothing here
  establishes that a contribution is deductible, and the UI is written so that no reader could think it does.

### 3.18 Idle capital in a lending venue (v6)

*The venue loses the money, or cannot return it when a supplier is owed.*

- **Mitigation.** Deployment only after funding closes, so no donor withdrawal can race it. Money a payee can
  claim this instant never leaves, and every payout path pulls back from the venue before paying and refuses to
  pay a part of a tranche while the rest is lent. Principal is tracked at cost, so a rising share price never
  lets the vault believe it has more than it was given; a falling one is recorded as `lossRealised` and charged
  against earnings before anything is handed on. A donor's refund is computed from what was donated and
  released, never from the balance, so nothing the venue does changes what a donor is owed.
- **Residual risk.** This adds a third party the escrow did not have: the venue's curator chooses which markets
  the money is lent into, and their oracles and liquidations are outside this system entirely. A loss larger
  than everything earned leaves the need short, and the last claimants feel it. The platform admin's allowlist
  is the only thing standing between an NGO and a bad venue, which makes that key as important as the pause.
  Disclosure is the compensating control: the need page states the venue, the amounts and the promise to the
  donor before anyone gives, and the NGO's opt-in is only possible before the need can be funded.

### 3.19 Card payments through the on-ramp (after §20)

*A card payment is lost between Coinbase and the need, or the platform ends up holding someone's money.*

- **Mitigation.** The platform never holds fiat and never holds USDC on anyone's behalf: Coinbase delivers to the
  donor's own wallet, and only the donor's signature moves it into the vault. The checkout session is created
  server-side, bound to the donor's address, single use and valid for five minutes; the CDP key never reaches the
  browser. The panel only offers for donation the USDC that arrived on top of the balance recorded before the
  purchase, so money the donor already held is never presented as if it had just been bought.
- **Residual risk.** Coinbase decides who may buy, where and how much; a donor it refuses has no card path here at
  all. A donor who buys and never taps "donate" simply keeps the USDC — nothing is lost, but nothing is given. Since v7
  the contracts have no provider path at all: no role can deposit on a donor's behalf or attest funding, and every
  need's money is in its own vault.

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
| Moving a pool to block conversions | Donations revert on the oracle bound instead of executing at a bad price; direct EURC and bank giving still work. On testnets the pool is rebalanced by re-running `SeedLiquidity` |
| Spamming deposit addresses | Creating one through the app costs the relayer a clone deployment; the route is rate limited. Anyone can also deploy one at their own cost, which harms no one |

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
8. Conversions trust Chainlink's feeds and the admin's choice of routes, and inherit Circle's issuer powers over
   USDC and EURC (§3.14). Coinbase Onramp is the only card path wired for mainnet; on test networks it is mocked.
9. A payment plan is only as independent as the admin's vetting of the suppliers in it (§3.15), and the fiat
   checkout settles a euro payment one-for-one in the vault's currency: it simulates a provider that has already
   converted, not an FX engine.
