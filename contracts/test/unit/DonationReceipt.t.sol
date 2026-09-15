// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidVault} from "../../src/funds/AidVault.sol";
import {DonationReceipt} from "../../src/funds/DonationReceipt.sol";
import {IAidVaultFactory} from "../../src/interfaces/IAidVaultFactory.sol";
import {IDonationReceipt} from "../../src/interfaces/IDonationReceipt.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {PoATest} from "../utils/PoATest.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

contract DonationReceiptTest is PoATest {
    uint256 internal needId;
    AidVault internal vault;

    function setUp() public override {
        super.setUp();
        (needId,, vault) = _verifiedNeed(10_000e6);
    }

    function test_constructor_revertsOnZeroFactory() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new DonationReceipt(roles, IAidVaultFactory(address(0)), "");
    }

    function test_mint_onlyVault() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.NotVault.selector);
        receipt.mint(donor1, needId, 1e6);
    }

    function test_mint_revertsOnNeedMismatch() public {
        vm.prank(address(vault));
        vm.expectRevert(Errors.NotVault.selector);
        receipt.mint(donor1, needId + 1, 1e6);
    }

    function test_mint_emitsLockedAndStoresReceipt() public {
        _fundDonor(donor1, needId, 250e6);
        vm.expectEmit(false, false, false, true, address(receipt));
        emit IDonationReceipt.Locked(1);
        vm.prank(donor1);
        vault.donate(250e6);

        IDonationReceipt.Receipt memory r = receipt.receiptOf(1);
        assertEq(r.needId, needId);
        assertEq(r.amount, 250e6);
        assertEq(r.timestamp, uint64(block.timestamp));
        assertEq(receipt.totalMinted(), 1);
        assertEq(receipt.ownerOf(1), donor1);
        assertTrue(receipt.locked(1));
    }

    function test_soulbound_transfersRevert() public {
        _donate(donor1, needId, 100e6);

        vm.prank(donor1);
        vm.expectRevert(Errors.Soulbound.selector);
        receipt.transferFrom(donor1, donor2, 1);

        vm.prank(donor1);
        vm.expectRevert(Errors.Soulbound.selector);
        receipt.safeTransferFrom(donor1, donor2, 1);

        vm.prank(donor1);
        vm.expectRevert(Errors.Soulbound.selector);
        receipt.approve(donor2, 1);

        vm.prank(donor1);
        vm.expectRevert(Errors.Soulbound.selector);
        receipt.setApprovalForAll(donor2, true);
    }

    function test_tokenURI_containsNeedAmountAndDashboardLink() public {
        _donate(donor1, needId, 1_234_560_000); // 1234.56 mEURC
        string memory uri = receipt.tokenURI(1);

        string memory prefix = "data:application/json;base64,";
        assertEq(_substring(uri, 0, bytes(prefix).length), prefix);
        string memory json = string(Base64.decode(_substring(uri, bytes(prefix).length, bytes(uri).length)));

        assertTrue(_contains(json, '"name":"Proof of Aid Receipt #1"'), "name");
        assertTrue(_contains(json, "1234.56 mEURC"), "formatted amount");
        assertTrue(_contains(json, string.concat(DASHBOARD_BASE_URI, vm.toString(needId))), "dashboard link");
        assertTrue(_contains(json, '"image":"data:image/svg+xml;base64,'), "image");
        assertTrue(_contains(json, '"trait_type":"Need"'), "attributes");
    }

    function test_tokenURI_revertsForUnknownToken() public {
        vm.expectRevert();
        receipt.tokenURI(99);
        vm.expectRevert();
        receipt.locked(99);
        vm.expectRevert();
        receipt.receiptOf(99);
    }

    function test_setDashboardBaseURI() public {
        vm.prank(outsider);
        vm.expectRevert(Errors.Unauthorized.selector);
        receipt.setDashboardBaseURI("https://evil.example/");

        vm.expectEmit(false, false, false, true, address(receipt));
        emit IDonationReceipt.DashboardBaseURIUpdated("https://new.example/needs/");
        vm.prank(admin);
        receipt.setDashboardBaseURI("https://new.example/needs/");
        assertEq(receipt.dashboardBaseURI(), "https://new.example/needs/");
    }

    function test_supportsInterface() public view {
        assertTrue(receipt.supportsInterface(type(IERC721).interfaceId), "erc721");
        assertTrue(receipt.supportsInterface(type(IERC165).interfaceId), "erc165");
        assertTrue(receipt.supportsInterface(0xb45a3c0e), "erc5192");
        assertFalse(receipt.supportsInterface(0xdeadbeef));
    }

    function test_metadata() public view {
        assertEq(receipt.name(), "Proof of Aid Donation Receipt");
        assertEq(receipt.symbol(), "POA-RECEIPT");
    }

    // ─── helpers ───────────────────────────────────────────────────────────────

    function _substring(string memory s, uint256 start, uint256 end) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; ++i) {
            out[i - start] = b[i];
        }
        return string(out);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool matched = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }
}
