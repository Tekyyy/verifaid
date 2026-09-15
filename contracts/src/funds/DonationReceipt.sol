// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleAware} from "../access/RoleAware.sol";
import {IAidVault} from "../interfaces/IAidVault.sol";
import {IAidVaultFactory} from "../interfaces/IAidVaultFactory.sol";
import {IDonationReceipt} from "../interfaces/IDonationReceipt.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title DonationReceipt
/// @notice Soulbound (ERC-5192) ERC-721 receipt minted to the donor for every direct donation.
/// @dev Metadata is fully on-chain: need id, amount and a link to the public dashboard.
contract DonationReceipt is IDonationReceipt, ERC721, RoleAware {
    using Strings for uint256;

    bytes4 private constant ERC5192_INTERFACE_ID = 0xb45a3c0e;

    IAidVaultFactory public immutable factory;

    /// @notice Number of receipts minted (also the latest token id).
    uint256 public totalMinted;
    /// @notice Base URL of the dashboard need page, e.g. "https://proofofaid.app/needs/".
    string public dashboardBaseURI;

    mapping(uint256 => Receipt) private _receipts;

    /// @param roles_ System role registry (admin may update the dashboard URL).
    /// @param factory_ Vault factory; only its vaults may mint.
    /// @param dashboardBaseURI_ Base URL of the dashboard need page.
    constructor(IRoleRegistry roles_, IAidVaultFactory factory_, string memory dashboardBaseURI_)
        ERC721("Proof of Aid Donation Receipt", "POA-RECEIPT")
        RoleAware(roles_)
    {
        if (address(factory_) == address(0)) revert Errors.ZeroAddress();
        factory = factory_;
        dashboardBaseURI = dashboardBaseURI_;
    }

    /// @inheritdoc IDonationReceipt
    function mint(address to, uint256 needId, uint256 amount) external returns (uint256 tokenId) {
        if (!factory.isVault(msg.sender) || IAidVault(msg.sender).needId() != needId) revert Errors.NotVault();
        tokenId = ++totalMinted;
        _receipts[tokenId] = Receipt({needId: needId, amount: amount, timestamp: uint64(block.timestamp)});
        // _mint (not _safeMint): no receiver callback, so minting can never re-enter the donating vault.
        _mint(to, tokenId);
        emit Locked(tokenId);
    }

    /// @notice Updates the dashboard base URL used in token metadata. Admin only.
    function setDashboardBaseURI(string calldata uri) external onlyAdmin {
        dashboardBaseURI = uri;
        emit DashboardBaseURIUpdated(uri);
    }

    // ─── soulbound ─────────────────────────────────────────────────────────────

    /// @dev Reverts on any transfer between two non-zero addresses.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Errors.Soulbound();
        return super._update(to, tokenId, auth);
    }

    /// @notice Approvals are meaningless for soulbound receipts.
    function approve(address, uint256) public pure override {
        revert Errors.Soulbound();
    }

    /// @notice Approvals are meaningless for soulbound receipts.
    function setApprovalForAll(address, bool) public pure override {
        revert Errors.Soulbound();
    }

    // ─── views ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IDonationReceipt
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    /// @inheritdoc IDonationReceipt
    function receiptOf(uint256 tokenId) external view returns (Receipt memory) {
        _requireOwned(tokenId);
        return _receipts[tokenId];
    }

    /// @notice On-chain JSON metadata (base64 data URI) with an inline SVG image.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Receipt memory r = _receipts[tokenId];
        string memory amount = _formatAmount(r.amount);
        string memory json = string.concat(
            '{"name":"Proof of Aid Receipt #',
            tokenId.toString(),
            '","description":"Soulbound receipt for a donation to Proof of Aid need #',
            r.needId.toString(),
            '. Follow the money on the public dashboard.","external_url":"',
            dashboardBaseURI,
            r.needId.toString(),
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(tokenId, r.needId, amount))),
            '","attributes":',
            _attributes(r, amount),
            "}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @inheritdoc ERC721
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == ERC5192_INTERFACE_ID || super.supportsInterface(interfaceId);
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    function _attributes(Receipt memory r, string memory amount) internal pure returns (string memory) {
        return string.concat(
            '[{"trait_type":"Need","display_type":"number","value":',
            r.needId.toString(),
            '},{"trait_type":"Amount","value":"',
            amount,
            '"},{"trait_type":"Donated at","display_type":"date","value":',
            uint256(r.timestamp).toString(),
            "}]"
        );
    }

    function _svg(uint256 tokenId, uint256 needId, string memory amount) internal pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240">',
            '<rect width="400" height="240" rx="16" fill="#0f766e"/>',
            '<text x="24" y="48" font-family="sans-serif" font-size="22" fill="#fff">Proof of Aid</text>',
            '<text x="24" y="110" font-family="sans-serif" font-size="34" fill="#fff">',
            amount,
            "</text>",
            '<text x="24" y="170" font-family="sans-serif" font-size="18" fill="#ccfbf1">Need #',
            needId.toString(),
            " - Receipt #",
            tokenId.toString(),
            "</text></svg>"
        );
    }

    /// @dev Formats a stablecoin amount with two decimals, e.g. "12.50 EURC".
    function _formatAmount(uint256 amount) internal view returns (string memory) {
        address token = address(factory.token());
        uint8 decimals = 6;
        string memory symbol = "";
        if (token != address(0)) {
            try IERC20Metadata(token).decimals() returns (uint8 d) {
                decimals = d;
            } catch {}
            try IERC20Metadata(token).symbol() returns (string memory s) {
                symbol = s;
            } catch {}
        }
        uint256 unit = 10 ** decimals;
        uint256 cents = decimals >= 2 ? (amount % unit) / (10 ** (decimals - 2)) : 0;
        return string.concat(
            (amount / unit).toString(),
            ".",
            cents < 10 ? "0" : "",
            cents.toString(),
            bytes(symbol).length > 0 ? " " : "",
            symbol
        );
    }
}
