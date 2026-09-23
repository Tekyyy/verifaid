// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReleasePolicy
/// @notice The rule a need's evidence is judged by: who has a say, what each say weighs, and how much agreement
///         approves or rejects it. A need picks one of the platform's approved policies when it is created and keeps
///         it for life, so the rule donors were shown is the rule their money is released under.
/// @dev Policies only answer questions; `DeliveryManager` records the evidence, counts the votes and acts on the
///      outcome. A new rule is a new policy contract the admin approves, with nothing else redeployed.
interface IReleasePolicy {
    /// @notice The capacity in which an address votes on a need's evidence.
    enum Voice {
        None,
        Donor, // weighs what the donor gave
        Verifier // an independent verifier; each one counts once
    }

    /// @notice What it takes to decide one piece of evidence. A voice whose approval requirement is zero has no say.
    struct Rules {
        uint256 donorApproval; // donations whose donors must approve
        uint256 donorRejection; // donations whose donors must reject
        uint8 verifierApproval; // independent verifiers who must approve
        uint8 verifierRejection; // independent verifiers who must reject
        uint8 retries; // times the NGO may start over on rejected or contested evidence before the need is cancelled
    }

    /// @notice Human-readable name, shown to donors next to the need.
    function name() external view returns (string memory);

    /// @notice The requirements for `needId`'s evidence. Only meaningful once funding has closed.
    function rulesOf(uint256 needId) external view returns (Rules memory);

    /// @notice In which capacity `voter` may vote on `needId`'s evidence, and with what weight (zero: no say).
    function voiceOf(uint256 needId, address voter) external view returns (Voice voice, uint256 weight);
}
