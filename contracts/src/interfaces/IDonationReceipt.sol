// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDonationReceipt
/// @notice Soulbound ERC-721 receipt minted for every direct donation.
interface IDonationReceipt {
    struct Receipt {
        uint64 needId;
        uint64 timestamp;
        uint128 amount;
    }

    /// @notice ERC-5192: emitted when a token becomes locked (always, at mint).
    event Locked(uint256 tokenId);
    /// @notice A donor took part of this donation back while the need was still raising.
    event ReceiptReduced(uint256 indexed tokenId, uint256 newAmount);
    event DashboardBaseURIUpdated(string uri);

    /// @notice Mints a receipt. Only callable by vaults registered in the factory.
    function mint(address to, uint256 needId, uint256 amount) external returns (uint256);

    /// @notice Lowers what a receipt says was given, after its owner withdrew part of the donation.
    ///         Only the vault of the receipt's own need, and only for the receipt's own owner.
    function reduce(uint256 tokenId, address owner, uint256 newAmount) external;

    /// @notice Receipt data for `tokenId`.
    function receiptOf(uint256 tokenId) external view returns (Receipt memory);

    /// @notice ERC-5192: receipts are always locked.
    function locked(uint256 tokenId) external view returns (bool);
}
