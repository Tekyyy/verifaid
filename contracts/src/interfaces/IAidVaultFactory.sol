// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INeedsRegistry} from "./INeedsRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IAidVaultFactory
/// @notice Deploys one minimal-proxy ledger per verified need: an AidVault or a NonCustodialLedger.
interface IAidVaultFactory {
    event VaultCreated(uint256 indexed needId, address vault, INeedsRegistry.CustodyMode custodyMode);
    event PaymentRefConsumed(bytes32 indexed paymentRefHash, address indexed provider, address indexed ledger);
    event Wired(address registry, address token, address vaultImplementation, address ledgerImplementation);

    /// @notice Clones the ledger for `needId`, with the need id baked into the clone's code. NeedsRegistry only.
    function createVault(uint256 needId, INeedsRegistry.CustodyMode custodyMode) external returns (address vault);

    /// @notice Marks `provider`'s payment reference as used system-wide, so one bank transfer or card payment
    ///         cannot fund two needs. References are scoped to the provider that issued them: one provider can
    ///         neither collide with nor squat another's. Callable only by ledgers created by this factory.
    function consumePaymentRef(address provider, bytes32 paymentRefHash) external;

    /// @notice True once `provider` has used `paymentRefHash` in any ledger.
    function isPaymentRefConsumed(address provider, bytes32 paymentRefHash) external view returns (bool);

    /// @notice True for custodial AidVaults created by this factory (the only contracts that may mint receipts).
    function isVault(address account) external view returns (bool);

    /// @notice True for any ledger created by this factory, custodial or not.
    function isLedger(address account) external view returns (bool);

    function token() external view returns (IERC20);
    function implementation() external view returns (address);
    function ledgerImplementation() external view returns (address);
}
