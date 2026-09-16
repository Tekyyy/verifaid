// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAidVaultFactory} from "../interfaces/IAidVaultFactory.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {INonCustodialLedger} from "../interfaces/INonCustodialLedger.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {TrancheLedger} from "./TrancheLedger.sol";

/// @title NonCustodialLedger
/// @notice Ledger for a need whose money never touches the chain (`CustodyMode.OffChain`, the proposal's Model A).
/// @dev The need's custodian, a payment provider the NGO names when it creates the need, holds the funds. Its
///      `FundingRecorded` attestations count toward the target and its `Settlement` attestations record each
///      tranche payout; both arrive through the resolver, which checks that the attester is the custodian, the
///      fee disclosure and the amounts first. Everything else is identical to the
///      custodial vault: the same deadlines, threshold, tranche split and three-signal delivery gate, so a need
///      can move between custody models without changing what donors are promised.
contract NonCustodialLedger is TrancheLedger, INonCustodialLedger {
    /// @notice The attestation resolver: the only caller that can record funding or releases.
    address public immutable resolver;

    constructor(
        IRoleRegistry roles_,
        INeedsRegistry registry_,
        address deliveryManager_,
        IAidVaultFactory factory_,
        address resolver_
    ) TrancheLedger(roles_, registry_, deliveryManager_, factory_) {
        if (resolver_ == address(0)) revert Errors.ZeroAddress();
        resolver = resolver_;
    }

    /// @inheritdoc INonCustodialLedger
    function recordFunding(
        address provider,
        uint256 gross,
        uint256 fee,
        uint256 net,
        bytes32 currency,
        bytes32 paymentRefHash,
        bytes32 donorRefHash
    ) external nonReentrant onlyClone {
        if (msg.sender != resolver) revert Errors.Unauthorized();
        uint256 id = needId();
        uint256 target = _checkFunding(id, net);

        _totalDonated += uint128(net);

        factory.consumePaymentRef(provider, paymentRefHash); // one payment funds one need, in either custody mode
        emit FundingRecorded(id, provider, gross, fee, net, currency, paymentRefHash, donorRefHash);

        if (_totalDonated == target) _closeFunding(id);
    }

    /// @inheritdoc INonCustodialLedger
    function recordRelease(uint256 index) external nonReentrant onlyClone returns (uint256 amount) {
        if (msg.sender != resolver) revert Errors.Unauthorized();
        uint256 id = needId();
        address payout;
        (amount, payout) = _release(id, index);
        emit TrancheReleased(id, index, amount, payout);
    }
}
