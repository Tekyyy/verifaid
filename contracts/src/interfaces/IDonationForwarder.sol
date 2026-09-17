// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDonationForwarder
/// @notice A deposit address for one donation intent. A card on-ramp (or anyone) sends tokens to it; anyone can then
///         sweep them, which converts them into the need's stablecoin and donates them to the need's vault. What
///         cannot be donated stays refundable, and only to where the intent says.
interface IDonationForwarder {
    /// @notice Everything the deposit address commits to. The address is derived from these values, so the tracking
    ///         reference (the address) cannot be squatted by anyone with different intentions.
    struct Intent {
        uint256 needId;
        /// @dev Wallet that receives the soulbound receipt and owns vault refunds directly; zero for card donors.
        address receiptTo;
        /// @dev Where undonated funds and vault refunds go; zero if only `refundSigner` may direct them.
        address refundTo;
        /// @dev Key (EOA or ERC-1271 wallet) that may send undonated funds and vault refunds anywhere by signature.
        address refundSigner;
        /// @dev Makes each intent's address unique.
        bytes32 salt;
    }

    event Swept(
        uint256 indexed needId,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 converted,
        uint256 fairValue,
        uint256 deposited,
        uint256 conversionFee
    );
    event LeftoverRefunded(address indexed token, address indexed to, uint256 amount);
    event VaultRefundClaimed(address indexed to, uint256 amount);

    /// @notice Converts this address's whole `tokenIn` balance (`address(0)` for ETH) and donates it. Anything above
    ///         what the need still needs goes to `refundTo` when there is one, and otherwise stays refundable.
    function sweep(address tokenIn) external returns (uint256 deposited);

    /// @notice Sends this address's `token` balance to `refundTo`. The donor (`refundTo`) may do this at any time;
    ///         anyone may once the need no longer accepts donations.
    function refund(address token) external;

    /// @notice Sends this address's `token` balance to `to`, authorized by an EIP-712 signature from `refundSigner`.
    function refundWithSignature(address token, address to, uint256 deadline, bytes calldata signature) external;

    /// @notice Claims the vault refund owed to this forwarder's donations (cancelled or expired need) to `refundTo`.
    function claimVaultRefund() external returns (uint256 amount);

    /// @notice Claims the vault refund to `to`, authorized by an EIP-712 signature from `refundSigner`.
    function claimVaultRefundWithSignature(address to, uint256 deadline, bytes calldata signature)
        external
        returns (uint256 amount);

    function intent() external view returns (Intent memory);

    /// @notice True while the need is on-chain custody, open for funding and below its target.
    function accepting() external view returns (bool);
}
