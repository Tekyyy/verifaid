// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

/// @title SemaphoreDeployer
/// @notice Deploys Semaphore v4 for chains where it is not published yet (local anvil, integration tests).
/// @dev Kept separate from `SystemDeployer` so only the deploy script and the real-proof integration test
///      pay for compiling the Semaphore verifier bytecode. On Base Sepolia the official deployment is reused:
///      Semaphore 0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D (see deployments/base-sepolia.json).
///      PoseidonT3 is an external library; Foundry deploys and links it automatically.
abstract contract SemaphoreDeployer {
    function _deployLocalSemaphore() internal returns (address semaphore, address verifier) {
        verifier = address(new SemaphoreVerifier());
        semaphore = address(new Semaphore(ISemaphoreVerifier(verifier)));
    }
}
