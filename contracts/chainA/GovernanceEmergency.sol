// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title GovernanceEmergency - Cross-chain emergency pause controller
/// @notice Receives governance decisions from the relayer (originating from Chain B)
///         and executes emergency actions on Chain A contracts.
interface IBridgeLock {
    function pause() external;
}

contract GovernanceEmergency is AccessControl {
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    IBridgeLock public bridgeLock;

    event BridgePaused(address indexed caller);

    constructor(address _bridgeLock, address relayer) {
        bridgeLock = IBridgeLock(_bridgeLock);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RELAYER_ROLE, relayer);
    }

    /// @notice Pause the bridge via governance decision relayed from Chain B
    function pauseBridge() external onlyRole(RELAYER_ROLE) {
        bridgeLock.pause();
        emit BridgePaused(msg.sender);
    }
}
