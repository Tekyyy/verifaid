// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INeedsRegistry} from "./INeedsRegistry.sol";
import {IRoleAware} from "./IRoleAware.sol";

/// @title IBeneficiaryRegistry
/// @notice The door a beneficiary uses to post a need of their own, on the strength of their NGO's certificate.
/// @dev An NGO's list of beneficiaries never reaches the chain. The NGO keeps it in its encrypted records and signs
///      a certificate (EIP-712) for each wallet it certifies; a wallet appears on chain only when that person posts a
///      need, or when their NGO withdraws the certification.
interface IBeneficiaryRegistry is IRoleAware {
    /// @notice What an NGO signs to certify a wallet, within one of its programmes, for a limited time.
    struct Certification {
        address beneficiary; // the wallet certified; only it can use the certificate
        address ngo; // the certifying NGO, which signs (an EOA or an ERC-1271 smart wallet)
        uint256 programId; // the NGO's programme the beneficiary belongs to; needs they post are part of it
        uint64 issuedAt; // a withdrawal voids every certificate issued up to that moment
        uint64 expiresAt; // the certificate cannot be used from this moment on
    }

    /// @notice A certified beneficiary posted a need (its terms are in `INeedsRegistry.NeedCreated`).
    /// @param certifiedAt `issuedAt` of the certificate used, so the NGO can tell which one it was.
    event BeneficiaryNeedPosted(
        uint256 indexed needId, address indexed beneficiary, address indexed ngo, uint256 programId, uint64 certifiedAt
    );

    /// @notice An NGO withdrew its certification of `beneficiary`: no certificate issued until now can be used.
    event CertificationRevoked(address indexed ngo, address indexed beneficiary);

    /// @notice Posts a need owned by the caller, who must be the certificate's beneficiary. The need goes through
    ///         the same verification, funding, tranches and evidence as an NGO's need, but its own share is paid to
    ///         the caller's wallet and may be the whole of it. One open need per beneficiary at a time.
    /// @param p The need's terms; `p.programId` must be the certificate's programme.
    /// @param signature The NGO's EIP-712 signature over `certification`.
    function createNeed(
        INeedsRegistry.CreateNeedParams calldata p,
        Certification calldata certification,
        bytes calldata signature
    ) external returns (uint256 needId);

    /// @notice Withdraws the caller's certification of `beneficiary`, voiding every certificate issued so far.
    ///         Callable by any registered NGO, suspended or not. Needs already posted are not affected: their money is
    ///         escrowed under the terms donors saw, and the NGO may still cancel them before funding closes.
    function revoke(address beneficiary) external;

    /// @notice True if `certification` would be accepted now, with `signature`, by `createNeed`.
    function isCertified(Certification calldata certification, bytes calldata signature) external view returns (bool);

    /// @notice The EIP-712 digest the NGO signs for `certification`.
    function certificationDigest(Certification calldata certification) external view returns (bytes32);

    /// @notice When `ngo` last withdrew its certification of `beneficiary` (zero if it never did).
    function revokedAt(address ngo, address beneficiary) external view returns (uint64);

    /// @notice The last need `beneficiary` posted (zero if none).
    function lastNeedOf(address beneficiary) external view returns (uint256);

    function registry() external view returns (INeedsRegistry);
}
