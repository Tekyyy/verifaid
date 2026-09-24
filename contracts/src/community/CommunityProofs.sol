// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAidVault} from "../interfaces/IAidVault.sol";
import {ICommunityProofs} from "../interfaces/ICommunityProofs.sol";
import {IDonationForwarderFactory} from "../interfaces/IDonationForwarderFactory.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title CommunityProofs
/// @notice Proof of delivery from people who do not run the need — a neighbour, a volunteer, a passer-by — and the
///         small rewards an NGO can offer them for it.
///
///         Anyone with a wallet can file photos about a need once its money has started to move. The files live off
///         chain, like delivery evidence; what the chain keeps is the manifest listing them by hash, and who filed it.
///         An NGO that wants more of this can open a reward pot on one of its needs: it locks `reward × maxRewards`
///         from its own wallet here, then grants one reward per proof it finds useful, at most once per wallet per
///         need. What is left goes back to the NGO when the pot closes.
///
///         A reward is not cash. It is credit here, which its holder can only give: to any need raising money, or to
///         a basket of needs split equally by the donation factory. The gift is this contract's on each vault, so it
///         carries no say on the need's evidence (an NGO paying rewards must not be buying votes), and if the need
///         fails its refund comes back to this contract and, pro rata, to each giver as credit again. So everything
///         an NGO pays for proof is, in the end, donated.
///
///         Community proof is context for donors, never a vote: it releases nothing and blocks nothing. Donors' money
///         is not involved — the pot is the NGO's own — and every proof stays public whether or not it was paid for,
///         so an NGO can decline to reward an unflattering photo but cannot hide it.
/// @dev The people who account for the need through `DeliveryManager` — its NGO, the NGO's payout address, and the
///      beneficiary who runs it — cannot file here, so an NGO cannot pay its own team out of a pot it opened "for the
///      community". A reward to a friend's wallet is still possible; the amounts are meant to be small, and every
///      payment is public next to the proof it paid for.
contract CommunityProofs is ICommunityProofs, RoleAware, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice The same cap as delivery evidence: the manifest lists files by hash, not the files themselves.
    uint256 public constant MAX_MANIFEST_BYTES = 8192;
    uint64 public constant MIN_BOUNTY_DURATION = 1 days;
    uint64 public constant MAX_BOUNTY_DURATION = 365 days;
    uint32 public constant MAX_REWARDS = 1000;
    /// @notice Proofs one wallet may file about one need. Enough to follow a delivery (the goods, the site, the
    ///         handover); a wallet that wants to flood a need's page has to pay for a new wallet every few.
    uint8 public constant MAX_PROOFS_PER_WALLET = 3;

    INeedsRegistry public immutable registry;
    /// @notice The stablecoin the needs raise, which rewards are paid in.
    IERC20 public immutable token;
    /// @notice Splits a credit gift across a basket of needs, and donates it in this contract's name.
    IDonationForwarderFactory public immutable donations;

    uint256 public proofCount;
    uint256 public bountyCount;
    /// @inheritdoc ICommunityProofs
    mapping(uint256 => uint256) public openBountyOf;
    /// @inheritdoc ICommunityProofs
    mapping(uint256 => mapping(address => bool)) public rewardedOn;
    /// @inheritdoc ICommunityProofs
    mapping(uint256 => mapping(address => uint256)) public proofsFiled;

    /// @inheritdoc ICommunityProofs
    mapping(address => uint256) public creditOf;
    /// @inheritdoc ICommunityProofs
    mapping(uint256 => mapping(address => uint256)) public creditGivenTo;
    /// @notice All the credit given to a need: the base its refund is shared out on.
    mapping(uint256 => uint256) public creditGivenTotal;
    /// @notice What this contract recovered from a failed need, once claimed (`refundClaimed`).
    mapping(uint256 => uint256) public refundOf;
    mapping(uint256 => bool) public refundClaimed;

    mapping(uint256 => Proof) private _proofs;
    mapping(uint256 => Bounty) private _bounties;

    constructor(IRoleRegistry roles_, INeedsRegistry registry_, IERC20 token_, IDonationForwarderFactory donations_)
        RoleAware(roles_)
    {
        if (address(registry_) == address(0) || address(token_) == address(0) || address(donations_) == address(0)) {
            revert Errors.ZeroAddress();
        }
        registry = registry_;
        token = token_;
        donations = donations_;
    }

    // ─── proofs ────────────────────────────────────────────────────────────────

    /// @inheritdoc ICommunityProofs
    function submitProof(uint256 needId, string calldata manifest) external whenNotPaused returns (uint256 proofId) {
        uint256 length = bytes(manifest).length;
        if (length == 0 || length > MAX_MANIFEST_BYTES) revert Errors.InvalidParameter();
        INeedsRegistry.NeedStatus status = registry.statusOf(needId);
        if (
            status != INeedsRegistry.NeedStatus.Funded && status != INeedsRegistry.NeedStatus.InDelivery
                && status != INeedsRegistry.NeedStatus.Completed
        ) revert Errors.InvalidNeedStatus();
        if (_accountsForNeed(needId, msg.sender)) revert Errors.NotIndependent();
        if (++proofsFiled[needId][msg.sender] > MAX_PROOFS_PER_WALLET) revert Errors.ProofLimitReached();

        proofId = ++proofCount;
        bytes32 manifestHash = keccak256(bytes(manifest));
        _proofs[proofId] = Proof({
            needId: uint128(needId),
            submittedAt: uint64(block.timestamp),
            rewarded: false,
            submitter: msg.sender,
            manifestHash: manifestHash
        });
        emit ProofSubmitted(proofId, needId, msg.sender, manifestHash, manifest);
    }

    // ─── reward pots ───────────────────────────────────────────────────────────

    /// @inheritdoc ICommunityProofs
    function openBounty(uint256 needId, uint256 reward, uint32 maxRewards, uint64 deadline)
        external
        whenNotPaused
        returns (uint256 bountyId)
    {
        if (registry.ngoOf(needId) != msg.sender || !roles.isActiveNgo(msg.sender)) {
            revert Errors.Unauthorized();
        }
        INeedsRegistry.NeedStatus status = registry.statusOf(needId);
        if (
            status == INeedsRegistry.NeedStatus.Pending || status == INeedsRegistry.NeedStatus.Cancelled
                || status == INeedsRegistry.NeedStatus.Expired
        ) revert Errors.InvalidNeedStatus();
        if (openBountyOf[needId] != 0) revert Errors.BountyAlreadyOpen();
        if (reward == 0) revert Errors.ZeroAmount();
        if (reward > type(uint128).max / MAX_REWARDS) revert Errors.InvalidParameter();
        if (maxRewards == 0 || maxRewards > MAX_REWARDS) revert Errors.InvalidParameter();
        if (deadline < block.timestamp + MIN_BOUNTY_DURATION || deadline > block.timestamp + MAX_BOUNTY_DURATION) {
            revert Errors.InvalidParameter();
        }

        uint256 total = reward * maxRewards;
        bountyId = ++bountyCount;
        _bounties[bountyId] = Bounty({
            needId: uint128(needId),
            deadline: deadline,
            maxRewards: maxRewards,
            rewardsPaid: 0,
            ngo: msg.sender,
            closed: false,
            reward: uint128(reward),
            balance: uint128(total)
        });
        openBountyOf[needId] = bountyId;
        token.safeTransferFrom(msg.sender, address(this), total);
        emit BountyOpened(bountyId, needId, msg.sender, reward, maxRewards, deadline);
    }

    /// @inheritdoc ICommunityProofs
    /// @dev The reward stays in this contract as the submitter's credit: nothing leaves until it is given away.
    function rewardProof(uint256 proofId) external whenNotPaused {
        Proof storage proof = _proofs[proofId];
        if (proof.submitter == address(0)) revert Errors.ProofNotFound();
        uint256 needId = proof.needId;
        uint256 bountyId = openBountyOf[needId];
        if (bountyId == 0) revert Errors.NoOpenBounty();
        Bounty storage bounty = _bounties[bountyId];
        if (msg.sender != bounty.ngo) revert Errors.Unauthorized();
        if (proof.submittedAt > bounty.deadline) revert Errors.ProofAfterDeadline();
        address submitter = proof.submitter;
        if (proof.rewarded || rewardedOn[needId][submitter]) revert Errors.AlreadyRewarded();
        uint128 amount = bounty.reward;
        // `balance` falls by exactly `reward` per payment, so it runs out when `maxRewards` have been paid.
        if (bounty.balance < amount) revert Errors.NothingToClaim();

        proof.rewarded = true;
        rewardedOn[needId][submitter] = true;
        bounty.rewardsPaid += 1;
        bounty.balance -= amount;
        creditOf[submitter] += amount;
        emit ProofRewarded(proofId, bountyId, needId, submitter, amount);
    }

    // ─── credit ────────────────────────────────────────────────────────────────

    /// @inheritdoc ICommunityProofs
    function giveCredit(bytes32 basket, uint256[] calldata needIds, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert Errors.ZeroAmount();
        uint256 held = creditOf[msg.sender];
        if (amount > held) revert Errors.InsufficientCredit();
        creditOf[msg.sender] = held - amount;

        token.forceApprove(address(donations), amount);
        (uint256[] memory amounts, uint256 returned) = donations.donateEqually(basket, needIds, amount);
        // What no need could take was never spent: it is still the giver's credit.
        if (returned != 0) creditOf[msg.sender] += returned;
        for (uint256 i; i < needIds.length; ++i) {
            uint256 part = amounts[i];
            if (part == 0) continue;
            creditGivenTo[needIds[i]][msg.sender] += part;
            creditGivenTotal[needIds[i]] += part;
        }
        emit CreditGiven(msg.sender, basket, needIds, amounts);
    }

    /// @inheritdoc ICommunityProofs
    /// @dev The vault owes this contract one refund per need, for every giver at once; the first to reclaim claims it,
    ///      and each giver then gets the share their credit was of all the credit given to that need.
    function reclaimCredit(uint256 needId) external nonReentrant whenNotPaused returns (uint256 amount) {
        INeedsRegistry.NeedStatus status = registry.statusOf(needId);
        if (status != INeedsRegistry.NeedStatus.Cancelled && status != INeedsRegistry.NeedStatus.Expired) {
            revert Errors.NotRefundable();
        }
        uint256 given = creditGivenTo[needId][msg.sender];
        if (given == 0) revert Errors.NothingToRefund();

        if (!refundClaimed[needId]) {
            refundClaimed[needId] = true;
            refundOf[needId] = IAidVault(registry.vaultOf(needId)).claimRefund();
        }
        amount = (given * refundOf[needId]) / creditGivenTotal[needId];
        creditGivenTo[needId][msg.sender] = 0;
        creditOf[msg.sender] += amount;
        emit CreditRefunded(msg.sender, needId, amount);
    }

    /// @inheritdoc ICommunityProofs
    /// @dev Not paused: returning an NGO's own money is safe in any state of the system.
    function closeBounty(uint256 bountyId) external {
        Bounty storage bounty = _bounties[bountyId];
        if (bounty.ngo == address(0)) revert Errors.BountyNotFound();
        if (bounty.closed) revert Errors.NoOpenBounty();
        if (msg.sender != bounty.ngo && block.timestamp <= bounty.deadline) revert Errors.Unauthorized();

        uint256 refund = bounty.balance;
        uint256 needId = bounty.needId;
        bounty.closed = true;
        bounty.balance = 0;
        delete openBountyOf[needId];
        if (refund > 0) token.safeTransfer(bounty.ngo, refund);
        emit BountyClosed(bountyId, needId, refund);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc ICommunityProofs
    function proofOf(uint256 proofId) external view returns (Proof memory) {
        return _proofs[proofId];
    }

    /// @inheritdoc ICommunityProofs
    function bountyOf(uint256 bountyId) external view returns (Bounty memory) {
        return _bounties[bountyId];
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev Whoever answers for the need through its delivery evidence: the NGO, its payout address, the owner who
    ///      runs it (the NGO or a certified beneficiary) and the owner's own payout.
    function _accountsForNeed(uint256 needId, address account) internal view returns (bool) {
        address ngo = registry.ngoOf(needId);
        return account == ngo || account == roles.payoutOf(ngo) || account == registry.ownerOf(needId)
            || account == registry.ownPayoutOf(needId);
    }
}
