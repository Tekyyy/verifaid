// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title Signatures
/// @notice Whether `signer` signed `hash`: with its own key, or — for a contract account — through ERC-1271.
/// @dev OpenZeppelin's SignatureChecker sends every account that has code to ERC-1271 alone. Since EIP-7702 an
///      ordinary wallet can have code too, delegated to a contract that may not implement ERC-1271 (or, as with the
///      sweeper contracts that anvil's well-known keys are delegated to on Base mainnet, not for its owner). Such a
///      wallet could then no longer sign a vote, a certificate or a refund with the key it has always had.
///      Checking the key first changes nothing for a contract account: no one holds a private key whose address is a
///      contract's, so an ECDSA signature can only recover to an account whose key really signed.
library Signatures {
    function isValidNow(address signer, bytes32 hash, bytes memory signature) internal view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        return signer.code.length != 0 && SignatureChecker.isValidERC1271SignatureNow(signer, hash, signature);
    }
}
