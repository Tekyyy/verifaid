// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "../external/IAggregatorV3.sol";

/// @title MockV3Aggregator
/// @notice TEST CONTRACT ONLY — a Chainlink-shaped price feed whose answer anyone can set. Stands in for feeds that
///         do not exist on a test network, and lets tests simulate stale or broken prices.
contract MockV3Aggregator is IAggregatorV3 {
    uint8 public immutable decimals;
    string public description;

    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public roundId;

    constructor(uint8 decimals_, int256 answer_, string memory description_) {
        decimals = decimals_;
        description = description_;
        updateAnswer(answer_);
    }

    /// @notice Sets a fresh answer. Anyone can call this — never use outside demos and tests.
    function updateAnswer(int256 answer_) public {
        answer = answer_;
        updatedAt = block.timestamp;
        startedAt = block.timestamp;
        roundId += 1;
    }

    /// @notice Sets the answer with explicit timestamps (stale prices, sequencer restarts).
    function updateRoundData(int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
        roundId += 1;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, roundId);
    }
}
