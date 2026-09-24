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
| The link "this person received aid" | Even without a name, a linkable record can expose someone | Nowhere on chain for the people an NGO serves; since v10 a beneficiary who posts a need of their own links their own wallet to it, by choice (§3.23) |
| Who an NGO has certified | The NGO's list of beneficiaries is a list of people at risk | The NGO's own records; a certificate reaches the chain only when its wallet posts a need, or is revoked (§3.23) |
| Evidence integrity | The claim "we delivered 120 kits" must be anchored in time | Manifest hash on chain; files by SHA-256, pinned to IPFS |
| The verification record | Who said a need was real, who approved or rejected each account | EAS attestations, `DeliveryManager` votes |
| The rules of a need | The release policy donors were shown must be the one their money is released under | Fixed per need in `NeedsRegistry` |
| Role assignments | Whoever controls roles controls the flow of money | `RoleRegistry` |

## 2. Trust assumptions

Stated plainly, because most of the security rests on them:

1. **The admin is honest-ish and slow to act.** Since v9 the admin is a TimelockController whose only proposer
   is a Safe multisig: every admin action needs the Safe's signatures and then waits out a public delay (ten
   minutes on the testnet, two days by default) before anyone may execute it. It can cancel needs, register
   organizations, suppliers and verifiers, approve release policies and the yield venue. It **cannot** move money
   out of a vault, and cannot change the release rule of a need that already exists (§3.20).
2. **Verifiers are independent of the NGO they verify.** This is enforced structurally (§4) rather than assumed.
3. **Somebody with a say reads each account.** A need's evidence is judged by its donors, its verifiers or both,
   by the rule it chose; if nobody looks, the next tranche simply waits and the money goes back at the deadline.
4. **The NGO's enrollment process is honest.** Nothing on-chain can tell a real household from an invented one.
5. **The stablecoin behaves like a standard ERC-20** and holds its peg.
7. **For off-chain custody (Model A), the named custodian is a regulated payment provider that really holds and
   pays out the money it attests.** The chain enforces who may attest and what the numbers must add up to; it
   cannot see a bank account. See §3.11.

## 3. Threats and mitigations

### 3.1 Fake or inflated needs

*An NGO invents a need, or inflates a real one, to attract donations.*

- **Mitigation.** A need can only start collecting money after `verificationsRequired` independent verifiers
  attest to it on-chain, against the exact `dossierHash` of the assessment they read. Above
  `HIGH_VALUE_THRESHOLD` at least two are required. A single rejection cancels the need.
- **Structural independence.** `RoleRegistry` enforces one operational role per address and rejects a verifier
  that is the NGO or its payout Safe. So "independence" is not a policy sentence, it
  is a precondition the contract checks on every attestation.
- **Residual risk.** Verifier–NGO collusion off-chain. The verifier's name is permanently attached to the
  attestation, which is a reputational deterrent, not a technical one. Roadmap: verifier staking with slashing,
  and random assignment of verifiers to needs so an NGO cannot choose its own reviewer.

### 3.2 Money leaving without delivery

*Funds are released although nothing was delivered.*

- **Mitigation.** Only tranche 0 (pre-financing, a deliberate design choice so NGOs can actually buy goods) is
  released without evidence. Every later tranche requires the NGO to account for the one before it — photos,
  receipts and bank statements committed on chain by hash — and **donors who gave 30% of the raised amount** to
  approve that account (§21 of DECISIONS).
- **No path around it.** `AidVault.markReleasable` is callable only by `DeliveryManager`, which calls it only from
  `approve`, once the approving donors' combined donations reach the threshold. Releases pay the need's registered
  suppliers; the amount comes from the tranche plan fixed when funding closed.
- **Residual risk.** The first tranche is unproven by construction. Keep it small for unfamiliar partners —
  the tranche plan is per need, and a 10/45/45 split is as valid as 30/40/30.

### 3.3 Fabricated evidence

*Photos, receipts and statements that do not correspond to what the money bought.*

- **Mitigation.** Each file is committed by its SHA-256 in a manifest the NGO signs, so it cannot be swapped after
  donors have seen it; filing new evidence discards every approval of the old. The files are public, so any donor —
  and anyone else — can check an invoice against its supplier or a statement against the payouts the vault made,
  which are themselves on chain.
- **Residual risk.** **Hashing proves integrity, not truth.** A staged photo or a forged receipt hashes just as
  well as a real one. The defence is people with money at stake reading the documents, 30% of the raised amount
  having to agree, and the supplier payments being visible on chain for comparison. It is weaker than an
  independent field audit, and says so.

### 3.4 Manufactured approval, or rejection

*The NGO, or someone close to it, approves its own account — or someone blocks an honest one.*

- **Mitigation.** Who has a say is the need's release policy (§3.20), fixed at creation. Under the donor rules the
  NGO, its payout address and the need's payees have no say, whatever they gave, and a vote weighs what the
  voter's wallet donated (`donatedBy`, frozen once funding closes), so splitting a gift across wallets gains
  nothing. To approve its own evidence through fresh wallets an NGO must itself have donated 30% of the raised
  amount — money that then goes to registered suppliers, not back to it. Under the verifier rules an independent
  verifier (never the NGO or its payout address) must sign, and a high-value need takes two.
- **Rejection.** Rejecting takes more agreement than approving (half of the money, against 30%), because it can end
  the need: the first rejection sends the NGO back to file better evidence, and the next cancels the need and
  refunds everything not yet released. Replacing evidence someone has already rejected costs that same second
  chance, so an NGO cannot wipe a losing vote by re-filing; once the chance is spent, contested evidence stands until
  the votes decide it.
- **Signed votes.** A vote can be signed for free and relayed (`voteBySig`, EIP-712, ERC-1271 for smart wallets).
  The signature names the voter, the delivery, the direction and a deadline; a voter votes once per delivery, so a
  signature cannot be replayed, and an old one expires. The relayer pays for a vote and can withhold it — the voter
  can always send it themselves — but can never forge or flip one.
- **Residual risk.** Collusion between an NGO and a large "donor", or an NGO and one of its suppliers funding the
  voting wallets. Verifier vetting of suppliers and the 25% cap on the NGO's own share bound what such a scheme can
  take; public payouts make it traceable. A donor holding half the money can cancel an honest need after one
  second chance — but that donor is then refunded pro rata like everyone else, so the attack costs them the need
  they paid for and gains them nothing. Choosing the "donors and a verifier" rule puts a verifier in the way of
  both kinds of abuse.

### 3.5 De-anonymizing beneficiaries

*Working out who received aid from public data.*

- **Mitigation.** No personal data, no GPS and no unsalted hashes of personal data reach the chain. Since v9
  beneficiaries do not appear on chain at all: a programme is a label and a hash of its published eligibility
  rules, and who is enrolled lives only in the NGO's encrypted PII vault. Evidence photos are stripped of EXIF and
  text metadata (GPS, camera serials, timestamps) before they are hashed and stored, and the upload form tells the
  NGO to black out names, faces and account numbers first. Regions are coarse ISO 3166-2 subdivisions, and impact
  reports below five people served are refused so a count cannot point at one household.
- **Since v10, one exception, taken by the person themselves.** A beneficiary who posts a need of their own puts
  their wallet on chain, next to the NGO that certified them and the need's category, region and amounts. Nothing
  else about them is published, and nobody an NGO certified appears unless they post (§3.23). Anything that wallet
  did before, or does after, is linkable to that need — so the app tells them before they post, and a fresh wallet
  for the purpose is the safer choice.
- **Residual risk.** *The evidence is public by design.* An NGO that uploads an unredacted statement or a photo of
  identifiable people publishes it, and its hash on chain cannot be removed. The file itself can be taken down from
  this app's storage — but once it is pinned to IPFS (§3.22) other nodes may already hold a copy, so a mistake can
  no longer be fully undone.

### 3.6 Coercion

*Someone forces a beneficiary to hand over aid.*

- **Residual risk.** **Not solvable technically.** On an NGO's need no beneficiary signs or confirms anything on
  chain, so there is nothing a coercer can extract from one either; what remains is a programme-design problem
  (distribution points, staff presence), and we should not pretend otherwise.
- **Needs a beneficiary posts (v10) change this.** Their tranches land in a wallet they control, so a coercer can
  demand the money, or demand that they post a need in the first place. What limits the damage: only the
  pre-financing tranche is paid before any evidence, each later one waits for the donors or verifiers, and the plan
  can pay a registered supplier (a landlord, a pharmacy) directly instead of the person. Where coercion is a known
  risk, the NGO should not certify people to hold money themselves; that is a judgement the certificate leaves to it.

### 3.7 Fund theft and key compromise

- **Mitigation.** No admin withdrawal path exists. `ReentrancyGuard` on every value-moving function, strict CEI,
  and a fuzz-and-invariant-tested accounting identity
  (`balance + released + refunded == donated`). Releases go only to the payout address recorded at registration;
  there is deliberately no setter for it, so a compromised admin key cannot redirect future tranches.
- **If one admin key is compromised:** since v9 there is no single admin key. The admin is a timelock whose only
  proposer is a Safe (2-of-3 on the testnet), so one stolen owner key can do nothing, and even the Safe's full
  threshold only *schedules*: a registration of a bogus NGO, verifier or supplier, a new release policy or yield
  venue waits out the public delay, during which the other owners can cancel it and the guardian can pause. Even a
  completed attack cannot take custody of escrowed funds or change an existing need's rules.
- **If the guardian key is compromised:** the attacker can pause the system, and nothing else. Unpausing is an
  admin action through the timelock; payouts, refunds and unwinding the yield sleeve are designed to keep working
  or to wait, never to strand money.
- **If an NGO key is compromised:** the attacker can create needs and close funding, but money still only moves
  to the NGO's payout Safe, and only through verified deliveries. The admin can deactivate the NGO, which blocks
  further releases immediately.
- **If a verifier key is compromised:** the attacker can verify needs, and — on needs whose release rule gives
  verifiers a say — approve or reject their evidence. High-value needs need two verifiers for both, and under the
  "donors and a verifier" rule the donors must approve as well.

### 3.8 Attestation-layer attacks

- **Schema squatting.** Anyone can register a schema in EAS pointing at one of our resolvers. Each resolver
  therefore derives the UID of the one schema it serves from its own address and rejects everything else, so a
  squatted schema cannot drive core state or slip past an indexer that filters on the five official UIDs.
- **Attestations to people.** Resolvers require `recipient` to be the expected contract, never an arbitrary
  address, so the attestation graph cannot be used as a back door for publishing data about a person.
- **Expiring attestations.** Rejected: an attestation that silently expires while still counted would be
  misleading.
- **Evidence chain forgery.** Delivery evidence is not an attestation since v8: it is a manifest committed by
  `DeliveryManager`, whose hash only the NGO of the need can file. An `ImpactReport` can only be published by that
  NGO, once every tranche has been released.

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
  deadline, a tranche already earned (releasable) holds expiry off for `EXPIRY_GRACE_PERIOD`, so work that was
  approved is paid before the rest goes back. The hold is bounded, so nothing can postpone refunds indefinitely
  (F3). Since v9 a need whose evidence is rejected past its retries does not wait for the deadline at all: it is
  cancelled on the spot and refunds open.
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
  held — another operational role, so an NGO's own payout Safe or a former verifier cannot be re-introduced as a
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
  released, never from the balance, so nothing the venue does changes what a donor is owed. Since v9 a deposit is
  refused when the shares it buys are worth less than it cost (beyond 0.1% of rounding): `deployIdle` is
  permissionless, so anyone could otherwise call it while a venue's share price was being inflated (the
  first-depositor attack) and hand the difference to whoever inflated it.
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

### 3.20 Governance and release policies (v9)

*The admin changes the rules under money that is already given, or approves a rule that lets an NGO release to
itself.*

- **Mitigation.** A need names its release policy when it is created and keeps it for life: withdrawing a policy
  only stops new needs from choosing it. `markReleasable` is still callable only by `DeliveryManager`, and a policy
  only answers questions (who has a say, what it weighs, how much agreement it takes); it cannot move money or pick
  a tranche. Approving a new policy is an admin action, so it waits out the timelock where anyone can read it first.
- **Residual risk.** A malicious policy approved through the full Safe threshold and the delay could give a single
  address a say on new needs. It would be visible on every need page that chose it (the page names the policy and
  states its rule), and it cannot touch needs created before it.

### 3.21 The vote relayer (v9)

*Someone makes the platform pay for spam, or the relayer censors votes.*

- **Mitigation.** The relay route checks the signature (ERC-1271 included) and simulates the call before spending
  gas, so only a real, still-valid vote by someone with a say is ever sent; it is rate limited per voter and per
  address. Censorship is bounded: a voter can always send the same vote as an ordinary transaction.
- **Residual risk.** The relayer is an operational cost, and it sees which votes arrive and when — no more than the
  chain shows once they are mined.

### 3.22 Evidence on IPFS (v9)

*The app's server loses the files, or a gateway serves something else.*

- **Mitigation.** With a pinning key configured, every uploaded file is pinned to IPFS and its CID is written into the
  manifest the NGO signs, beside the SHA-256. The files route falls back to IPFS when its own copy is gone and serves
  the bytes only if they hash to what the chain committed to; a gateway can be slow or down, never silently wrong.
- **Residual risk.** Pinning is a service (Pinata) the platform pays for; if it lapses and no one else pinned the file,
  the file can still disappear, leaving a hash with nothing behind it. Evidence uploaded without a key is on the
  app's server only.

### 3.23 Needs a beneficiary posts, and the certificates behind them (v10)

*Someone posts a need as a beneficiary without being one, or learns who an NGO serves.*

- **Mitigation.** Only a wallet an NGO certified can post, and only with that NGO's EIP-712 signature, bound to the
  chain and to the `BeneficiaryRegistry` it was signed for; the contract accepts it only from the wallet it names, so
  a leaked link is useless to anyone else. Certificates expire (the app defaults to 30 days) and the NGO can withdraw
  them. A wallet that holds or ever held an operational role cannot post as a beneficiary, the beneficiary is never
  independent of their own need, and neither they nor their NGO has a say on its evidence. Every such need is still
  attested by independent verifiers before it can take money, and one beneficiary has one open need at a time. The
  certifying NGO answers for it: suspending the NGO freezes its beneficiaries' needs.
- **Residual risk.** *An NGO can certify wallets it controls.* A beneficiary's own share has no cap (an NGO's is
  25%), so an NGO inventing beneficiaries could route whole needs to itself; what stands in the way is the
  independent verification of each need and the approval of each tranche against evidence — the same defence as a
  fake need (§3.1), without the supplier vetting of §3.15. The "donors and a verifier" rule puts a verifier on every
  tranche. What the NGO must have checked before certifying someone is not yet specified (a certification scheme is
  planned). A certificate link, and a withdrawal on chain, both say that the NGO certified that wallet: the link is
  for the beneficiary alone, and a withdrawal publishes the wallet, which is why short certificates that expire are
  the quiet way to end one.

### 3.24 News on a need's page (v10 app)

*The news search gives away something about the people a need helps, turns the app's server against its own network,
or puts something false in front of donors.*

- **Mitigation.** The search is built from the need's category and coarse region only, both public on chain — never
  from its description, its presentation or anyone's details — so a search engine learns nothing the chain does not
  show. The server fetches article pages whose addresses come from the feeds, so each address, and every redirect hop,
  is checked first: http(s) on the standard ports, no credentials, no `localhost`, `.local` or `.internal` names, and
  every address the name resolves to must be public (no loopback, private, link-local, shared, multicast or metadata
  ranges, IPv4 written inside IPv6 included). Only HTML is read, at most 512 KB and only as far as the end of its head,
  within 4 seconds; feeds get 6 seconds and 1 MB. Text from feeds and pages is rendered as text, never as HTML; links
  open in a new tab with `noopener noreferrer`; images must be https and load with no referrer. Results are cached for
  three hours per region and category, so readers cannot make the server hammer a site. The section says the articles
  were found automatically and are context, not evidence: nothing in it is signed, written on chain, or decides
  anything.
- **Residual risk.** A name that resolves to a public address when checked and a private one when fetched (DNS
  rebinding) is not closed; what the server would read back is a page's Open Graph tags, and only those reach the
  page. An article can still be off topic, wrong or hostile: the relevance filter requires the problem and the place in
  its title or snippet, which removes most noise but checks no facts. Preview images load from the news sites, which
  see the reader's IP address (not which need they were reading). The Bing and Google feeds allow personal,
  non-commercial use only; a production deployment needs a licensed news API. `NEWS_SEARCH=off` turns the search off.

### 3.10 GDPR versus immutability

- **Mitigation.** Personal data is only ever in the PII vault, encrypted with a per-record data key. Erasure is
  crypto-shredding: destroy the wrapped data key and the ciphertext is unrecoverable. Nothing on chain refers to the
  people an NGO serves, so erasure is complete once the key is gone. The exception (v10) is a beneficiary who posted a
  need of their own: their wallet address stays on chain with it, as they were told before posting; it is not
  personal data by itself, but it cannot be erased.
- **Residual risk.** Evidence files are public and, once pinned, replicated (§3.5, §3.22): a photo that should not
  have been published cannot be recalled from every copy. A legal review is required before any production
  deployment; nothing here constitutes advice that the design is GDPR-compliant.

## 4. What an outside observer can learn

Everything on-chain is public. Concretely, an observer sees: which NGOs exist and their public profiles; which
needs exist, their category, coarse region, target, tranche plan and release rule; who verified what; every
donation amount and the donor's address; when tranches were released and to which payees; every piece of delivery
evidence — its manifest, its files by hash and, where pinned, by CID — and every vote on it, with the voter's
address and weight.

Since v10 they also see the wallet of every beneficiary who posted a need of their own, the NGO that certified it,
and every certification an NGO withdrew.

They cannot learn: who any beneficiary is — the people an NGO serves are not on chain, and a beneficiary who posted
a need appears only as a wallet — which wallets an NGO certified that never posted, or what the needs assessment
says.

**The evidence is the part that can leak.** It is public by design, so its safety rests on the NGO redacting names,
faces and account numbers before uploading, and on the app stripping photo metadata; see §3.5.

## 5. Denial of service and griefing

| Vector | Handling |
|---|---|
| A voter trying to vote twice | One vote per address per delivery, either way, whether sent or signed |
| An NGO re-filing to reset a losing vote | Replacing evidence someone already rejected costs the need's second chance; once it is spent, contested evidence cannot be replaced |
| Donations blocking a need | Overfunding reverts, so a donor cannot push a need past its target to jam it |
| Blocking expiry | A releasable tranche holds expiry off for at most 14 days after the execution deadline |
| Spam needs | Only registered, active NGOs can create needs, and people they certified — one open need at a time each; every need is verified before it can raise money, and the admin can deactivate an NGO |
| Vote spam through the relayer | Signatures are checked and the call simulated before any gas is spent; rate limited per voter and per address. An operational cost, not a contract vulnerability |
| Moving a pool to block conversions | Donations revert on the oracle bound instead of executing at a bad price; direct EURC and bank giving still work. On testnets the pool is rebalanced by re-running `SeedLiquidity` |
| Spamming deposit addresses | Creating one through the app costs the relayer a clone deployment; the route is rate limited. Anyone can also deploy one at their own cost, which harms no one |

## 6. Known limitations

1. Contracts are **not upgradeable** and **not audited**. This is a hackathon MVP.
2. On the testnet two of the three owner keys of the admin Safe (the deployer and a demo account) are held by the
   same operator, so the multisig demonstrates the mechanism rather than an independent quorum; the timelock is ten
   minutes, not days.
3. Delivery evidence is public by design (§3.3, §3.5); there is no private-evidence mode for verifiers any more.
4. The relayer sees the votes it relays, and when — nothing the chain does not show once they are mined.
5. Fee-on-transfer or rebasing tokens are not supported.
7. Off-chain custody is only as honest as its custodian (§3.11); the checkout, CSV import and settlement endpoints
   of the bank connector are a sandbox, not a payment integration.
6. Floor rounding leaves at most a few base units of dust in a vault after refunds.
8. Conversions trust Chainlink's feeds and the admin's choice of routes, and inherit Circle's issuer powers over
   USDC and EURC (§3.14). Coinbase Onramp is the only card path wired for mainnet; on test networks it is mocked.
9. A payment plan is only as independent as the admin's vetting of the suppliers in it (§3.15), and the fiat
   checkout settles a euro payment one-for-one in the vault's currency: it simulates a provider that has already
   converted, not an FX engine.
