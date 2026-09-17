// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAidVault} from "../interfaces/IAidVault.sol";
import {IConversionRouter} from "../interfaces/IConversionRouter.sol";
import {INeedsRegistry} from "../interfaces/INeedsRegistry.sol";
import {ITrancheLedger} from "../interfaces/ITrancheLedger.sol";
import {Errors} from "../libraries/Errors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title DonationConversion
/// @notice Converts a donation already held by the calling contract into the need's stablecoin and deposits it.
///         Shared by the deposit-address forwarders and the factory's direct wallet path.
library DonationConversion {
    using SafeERC20 for IERC20;

    address internal constant NATIVE = address(0);

    struct Result {
        uint256 received; // stablecoin the conversion produced
        uint256 fairValue; // what the input was worth at oracle prices, in the stablecoin
        uint256 deposited; // what the need could still take (≤ received)
        uint256 conversionFee; // fair value minus received, attributed to the deposited part
        uint256 receiptId;
    }

    /// @notice True while `needId` is on-chain custody, open for funding and below its target.
    function accepting(INeedsRegistry registry, uint256 needId) internal view returns (bool) {
        (, uint256 target,, bool open) = registry.fundingTermsOf(needId);
        if (!open || registry.custodyModeOf(needId) != INeedsRegistry.CustodyMode.OnChain) return false;
        return ITrancheLedger(registry.vaultOf(needId)).totalDonated() < target;
    }

    /// @dev Converts `amountIn` of `tokenIn` held by `address(this)` (`NATIVE` for ETH) and donates up to what the
    ///      need still needs. The undonated remainder, in the stablecoin, stays with the caller.
    function convertAndDonate(
        INeedsRegistry registry,
        IConversionRouter router,
        IERC20 token,
        uint256 needId,
        address tokenIn,
        uint256 amountIn,
        address receiptTo
    ) internal returns (Result memory r) {
        if (!accepting(registry, needId)) revert Errors.NotAccepting();

        if (tokenIn == address(token)) {
            (r.received, r.fairValue) = (amountIn, amountIn);
        } else if (tokenIn == NATIVE) {
            (r.received, r.fairValue) = router.convert{value: amountIn}(NATIVE, amountIn, address(token), address(this));
        } else {
            IERC20(tokenIn).forceApprove(address(router), amountIn);
            (r.received, r.fairValue) = router.convert(tokenIn, amountIn, address(token), address(this));
        }
        if (r.received == 0) revert Errors.InsufficientOutput();

        IAidVault vault = IAidVault(registry.vaultOf(needId));
        (, uint256 target,,) = registry.fundingTermsOf(needId);
        r.deposited = Math.min(r.received, target - vault.totalDonated());
        // The conversion cost of what is donated: fair value minus what the swap returned, pro rata.
        r.conversionFee = r.fairValue > r.received ? Math.mulDiv(r.fairValue - r.received, r.deposited, r.received) : 0;

        token.forceApprove(address(vault), r.deposited);
        r.receiptId = vault.donateVia(r.deposited, r.conversionFee, receiptTo);
    }
}
