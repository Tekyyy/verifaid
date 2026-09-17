// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAidVault} from "../interfaces/IAidVault.sol";
import {IConversionRouter} from "../interfaces/IConversionRouter.sol";
import {IDonationForwarder} from "../interfaces/IDonationForwarder.sol";
import {IDonationForwarderFactory} from "../interfaces/IDonationForwarderFactory.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {DonationConversion} from "./DonationConversion.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title DonationForwarder
/// @notice The deposit address of one donation intent. An exchange withdrawal (or any wallet) delivers USDC or ETH
///         here; `sweep` converts what the need can take into its stablecoin through the ConversionRouter
///         (oracle-bounded) and donates it to the need's vault.
/// @dev An EIP-1167 clone with the `Intent` appended to its code, deployed at a CREATE2 address derived from that
///      intent, so the address is known and shareable before the forwarder exists. Nothing here needs trusting a
///      server: the destination vault, the refund rules and the conversion bound are all fixed by the intent and
///      the system contracts. The forwarder never holds funds longer than until someone sweeps or refunds them.
contract DonationForwarder is IDonationForwarder, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant REFUND_TYPEHASH =
        keccak256("Refund(address token,address to,uint256 nonce,uint256 deadline)");
    bytes32 public constant VAULT_REFUND_TYPEHASH = keccak256("VaultRefund(address to,uint256 nonce,uint256 deadline)");
    address public constant NATIVE = address(0);

    INeedsRegistry public immutable registry;
    IConversionRouter public immutable router;
    /// @notice The stablecoin every vault holds.
    IERC20 public immutable token;
    /// @inheritdoc IDonationForwarder
    address public immutable factory;
    address private immutable _self;

    /// @inheritdoc IDonationForwarder
    uint256 public nonce;

    /// @dev Deployed by the factory itself, which is how every clone knows whose keepers may sweep it.
    constructor(INeedsRegistry registry_, IConversionRouter router_, IERC20 token_)
        EIP712("ProofOfAidDonationForwarder", "1")
    {
        if (address(registry_) == address(0) || address(router_) == address(0) || address(token_) == address(0)) {
            revert Errors.ZeroAddress();
        }
        registry = registry_;
        router = router_;
        token = token_;
        factory = msg.sender;
        _self = address(this);
    }

    modifier onlyClone() {
        if (address(this) == _self) revert Errors.NotLedger();
        _;
    }

    /// @notice On-ramps and wallets may deliver native ETH.
    receive() external payable {}

    // ─── donate ────────────────────────────────────────────────────────────────

    /// @inheritdoc IDonationForwarder
    function sweep(address tokenIn) external nonReentrant onlyClone returns (uint256 deposited) {
        Intent memory it = intent();
        // The factory has already checked its own caller.
        if (
            msg.sender != factory && msg.sender != it.receiptTo && msg.sender != it.refundTo
                && !IDonationForwarderFactory(factory).isKeeper(msg.sender)
        ) revert Errors.Unauthorized();
        uint256 balance = _balanceOf(tokenIn);
        if (balance == 0) revert Errors.NothingToSweep();

        DonationConversion.Result memory r =
            DonationConversion.convertAndDonate(registry, router, token, it.needId, tokenIn, balance, it.receiptTo);
        deposited = r.deposited;
        emit Swept(it.needId, tokenIn, r.amountIn, r.received, r.fairValue, r.deposited, r.conversionFee);

        // The need filled up: whatever is left here, converted or not, goes straight back when there is somewhere
        // to send it. (A need that is still accepting took everything this sweep produced.)
        if (it.refundTo != address(0) && !accepting()) {
            _refundIfAny(address(token), it.refundTo);
            if (tokenIn != address(token)) _refundIfAny(tokenIn, it.refundTo);
        }
    }

    // ─── refunds ───────────────────────────────────────────────────────────────

    /// @inheritdoc IDonationForwarder
    function refund(address tokenAddress) external nonReentrant onlyClone {
        Intent memory it = intent();
        if (it.refundTo == address(0)) revert Errors.Unauthorized();
        // Until swept, the money is still the donor's; once the need stops accepting, anyone may send it home.
        if (msg.sender != it.refundTo && accepting()) revert Errors.Unauthorized();
        _refundAll(tokenAddress, it.refundTo);
    }

    /// @inheritdoc IDonationForwarder
    function refundWithSignature(address tokenAddress, address to, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        onlyClone
    {
        _useSignature(
            keccak256(abi.encode(REFUND_TYPEHASH, tokenAddress, to, nonce, deadline)), to, deadline, signature
        );
        _refundAll(tokenAddress, to);
    }

    /// @inheritdoc IDonationForwarder
    function claimVaultRefund() external nonReentrant onlyClone returns (uint256 amount) {
        Intent memory it = intent();
        if (it.refundTo == address(0)) revert Errors.Unauthorized();
        amount = _claimVaultRefund(it, it.refundTo);
    }

    /// @inheritdoc IDonationForwarder
    function claimVaultRefundWithSignature(address to, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        onlyClone
        returns (uint256 amount)
    {
        _useSignature(keccak256(abi.encode(VAULT_REFUND_TYPEHASH, to, nonce, deadline)), to, deadline, signature);
        amount = _claimVaultRefund(intent(), to);
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IDonationForwarder
    function intent() public view returns (Intent memory) {
        return abi.decode(Clones.fetchCloneArgs(address(this)), (Intent));
    }

    /// @inheritdoc IDonationForwarder
    function accepting() public view returns (bool) {
        return DonationConversion.accepting(registry, intent().needId);
    }

    /// @notice The EIP-712 domain separator refund signatures are made against (bound to this forwarder).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    function _claimVaultRefund(Intent memory it, address to) internal returns (uint256 amount) {
        // Donations with a receipt belong to the receipt holder, who claims from the vault directly.
        if (it.receiptTo != address(0)) revert Errors.Unauthorized();
        IAidVault vault = IAidVault(registry.vaultOf(it.needId));
        amount = vault.claimRefundByRef(bytes32(uint256(uint160(address(this)))), to);
        emit VaultRefundClaimed(to, amount);
    }

    /// @dev The nonce is part of the signed struct and moves on every use, so a signature cannot be replayed on money
    ///      that arrives later.
    function _useSignature(bytes32 structHash, address to, uint256 deadline, bytes calldata signature) internal {
        address signer = intent().refundSigner;
        if (signer == address(0) || to == address(0)) revert Errors.Unauthorized();
        if (block.timestamp > deadline) revert Errors.SignatureExpired();
        if (!SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(structHash), signature)) {
            revert Errors.InvalidSignature();
        }
        ++nonce;
    }

    function _refundAll(address tokenAddress, address to) internal {
        uint256 amount = _balanceOf(tokenAddress);
        if (amount == 0) revert Errors.NothingToSweep();
        _send(tokenAddress, to, amount);
    }

    function _refundIfAny(address tokenAddress, address to) internal {
        uint256 amount = _balanceOf(tokenAddress);
        if (amount > 0) _send(tokenAddress, to, amount);
    }

    function _send(address tokenAddress, address to, uint256 amount) internal {
        if (tokenAddress == NATIVE) {
            // The destination is the intent's refundTo or one the refund key signed for: exactly who may receive it.
            // forge-lint: disable-next-line(arbitrary-send-eth)
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert Errors.TransferFailed();
        } else {
            IERC20(tokenAddress).safeTransfer(to, amount);
        }
        emit LeftoverRefunded(tokenAddress, to, amount);
    }

    function _balanceOf(address tokenAddress) internal view returns (uint256) {
        return tokenAddress == NATIVE ? address(this).balance : IERC20(tokenAddress).balanceOf(address(this));
    }
}
