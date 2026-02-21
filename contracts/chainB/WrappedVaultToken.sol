// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title WrappedVaultToken - Bridged representation of VaultToken on Chain B
/// @notice Minted 1:1 when tokens are locked on Chain A. Burned to unlock on Chain A.
///         Only the BridgeMint contract can mint or burn.
contract WrappedVaultToken is ERC20, AccessControl {
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");

    constructor(address bridgeMint) ERC20("WrappedVaultToken", "wVLT") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(BRIDGE_ROLE, bridgeMint);
    }

    /// @notice Mint wrapped tokens (called by BridgeMint after lock on Chain A)
    function mint(address to, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        _mint(to, amount);
    }

    /// @notice Burn wrapped tokens (called by BridgeMint during bridge-back)
    function burn(address from, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        _burn(from, amount);
    }
}
