// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAidVault} from "../interfaces/IAidVault.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {IRoleRegistry} from "../interfaces/IRoleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";
import {Roles} from "../libraries/Roles.sol";
import {ProofOfAidResolver} from "./ProofOfAidResolver.sol";
import {Attestation, IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/// @title FiatDonationResolver
/// @notice Resolver for `FiatDonation` attestations: a bank partner vouches for a fiat payment it deposited on-chain.
/// @dev `paymentRefHash = keccak256(abi.encode(partnerSalt, iso20022EndToEndId))` — salted, never the raw reference.
contract FiatDonationResolver is ProofOfAidResolver {
    string public constant SCHEMA = "uint256 needId,uint256 amount,bytes32 paymentRefHash,bytes32 donorRefHash";
    bool public constant REVOCABLE = false;

    INeedsRegistry public immutable registry;

    /// @notice paymentRefHash => FiatDonation attestation UID.
    mapping(bytes32 => bytes32) public attestationOf;

    event FiatDonationLinked(uint256 indexed needId, bytes32 indexed paymentRefHash, bytes32 attestationUID);

    constructor(IEAS eas, IRoleRegistry roles_, INeedsRegistry registry_)
        ProofOfAidResolver(eas, roles_, SCHEMA, REVOCABLE)
    {
        if (address(registry_) == address(0)) revert Errors.ZeroAddress();
        registry = registry_;
    }

    /// @dev attester must hold BANK_PARTNER_ROLE and a matching `DonatedOnBehalf` record must exist in the vault.
    function onAttest(Attestation calldata attestation, uint256) internal override returns (bool) {
        _checkAttestation(attestation);
        (uint256 needId, uint256 amount, bytes32 paymentRefHash, bytes32 donorRefHash) =
            abi.decode(attestation.data, (uint256, uint256, bytes32, bytes32));

        if (!roles.hasRole(Roles.BANK_PARTNER_ROLE, attestation.attester)) revert Errors.Unauthorized();
        address vault = registry.vaultOf(needId);
        if (vault == address(0) || attestation.recipient != vault) revert Errors.InvalidRecipient();
        if (attestationOf[paymentRefHash] != bytes32(0)) revert Errors.FiatDonationAlreadyAttested();

        IAidVault.FiatDonationRecord memory record = IAidVault(vault).fiatDonation(paymentRefHash);
        if (record.partner != attestation.attester || record.amount != amount || record.donorRefHash != donorRefHash) {
            revert Errors.FiatDonationMismatch();
        }

        attestationOf[paymentRefHash] = attestation.uid;
        emit FiatDonationLinked(needId, paymentRefHash, attestation.uid);
        return true;
    }

    /// @dev Fiat donation attestations are irrevocable.
    function onRevoke(Attestation calldata, uint256) internal pure override returns (bool) {
        revert Errors.NotRevocable();
    }
}
