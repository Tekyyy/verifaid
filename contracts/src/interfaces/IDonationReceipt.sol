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
    event DashboardBaseURIUpdated(string uri);

    /// @notice Mints a receipt. Only callable by vaults registered in the factory.
    function mint(address to, uint256 needId, uint256 amount) external returns (uint256);

    /// @notice Receipt data for `tokenId`.
    function receiptOf(uint256 tokenId) external view returns (Receipt memory);

    /// @notice ERC-5192: receipts are always locked.
    function locked(uint256 tokenId) external view returns (bool);
}
