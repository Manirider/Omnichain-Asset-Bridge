// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title VaultToken - Settlement chain ERC20 token
/// @notice Standard ERC20 used as the underlying asset for the bridge
contract VaultToken is ERC20 {
    constructor(uint256 initialSupply) ERC20("VaultToken", "VLT") {
        _mint(msg.sender, initialSupply);
    }
}
