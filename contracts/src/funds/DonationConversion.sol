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
        uint256 amountIn; // input actually used; the rest of what the caller holds was not touched
        uint256 received; // stablecoin the conversion produced
        uint256 fairValue; // what the input used was worth at oracle prices, in the stablecoin
        uint256 deposited; // what the need could still take (≤ received)
        uint256 conversionFee; // fair value minus received, attributed to the deposited part
        uint256 receiptId;
    }

    /// @notice True while `needId` is open for funding and below its target.
    function accepting(INeedsRegistry registry, uint256 needId) internal view returns (bool) {
        (, uint256 target,, bool open) = registry.fundingTermsOf(needId);
        if (!open) return false;
        return ITrancheLedger(registry.vaultOf(needId)).totalDonated() < target;
    }

    /// @dev Uses at most `amountIn` of `tokenIn` held by `address(this)` (`NATIVE` for ETH): only as much as the need
    ///      can still take, converted, and donated. What is not used stays with the caller in `tokenIn`, and any
    ///      stablecoin the swap produced beyond the target stays with the caller too.
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
        IAidVault vault = IAidVault(registry.vaultOf(needId));
        (, uint256 target,,) = registry.fundingTermsOf(needId);
        uint256 remaining = target - vault.totalDonated();

        if (tokenIn == address(token)) {
            r.amountIn = Math.min(amountIn, remaining);
            (r.received, r.fairValue) = (r.amountIn, r.amountIn);
        } else {
            // Converting a whole balance for a nearly full need would expose all of it to the swap and hand most of it
            // back already converted; the router says how much input is enough to fill the need at the bound.
            r.amountIn = Math.min(amountIn, router.maxInputFor(tokenIn, address(token), remaining));
            if (tokenIn == NATIVE) {
                (r.received, r.fairValue) =
                    router.convert{value: r.amountIn}(NATIVE, r.amountIn, address(token), address(this));
            } else {
                IERC20(tokenIn).forceApprove(address(router), r.amountIn);
                (r.received, r.fairValue) = router.convert(tokenIn, r.amountIn, address(token), address(this));
            }
        }
        if (r.received == 0) revert Errors.InsufficientOutput();

        r.deposited = Math.min(r.received, remaining);
        // The conversion cost of what is donated: fair value minus what the swap returned, pro rata, rounded up so a
        // cost never disappears into rounding (a need that disclosed no costs refuses any).
        if (r.fairValue > r.received) {
            r.conversionFee = Math.mulDiv(r.fairValue - r.received, r.deposited, r.received, Math.Rounding.Ceil);
        }

        token.forceApprove(address(vault), r.deposited);
        r.receiptId = vault.donateVia(r.deposited, r.conversionFee, receiptTo);
    }
}
