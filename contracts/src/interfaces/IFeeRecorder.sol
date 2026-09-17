// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFeeRecorder
/// @notice Where a vault reports conversion costs so they count against the need's disclosed cost cap together
///         with the fees payment providers attest (implemented by ProofOfAidResolver).
interface IFeeRecorder {
    event ConversionFeeRecorded(uint256 indexed needId, uint256 fee);

    /// @notice Adds `fee` to the need's inbound fees and reverts if the cumulative cap is exceeded. Callable only by
    ///         the need's own vault, after the donation it belongs to was counted.
    function recordConversionFee(uint256 needId, uint256 fee) external;
}
