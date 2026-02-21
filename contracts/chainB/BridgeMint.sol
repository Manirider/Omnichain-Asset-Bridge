// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BridgeMint - Mints and burns wrapped tokens on Chain B
/// @notice The relayer calls mintWrapped after detecting a Lock on Chain A.
///         Users call burn to initiate a bridge-back to Chain A.
interface IWrappedVaultToken {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

contract BridgeMint is AccessControl, ReentrancyGuard {
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    IWrappedVaultToken public wrappedToken;

    /// @notice Auto-incrementing nonce for burn operations
    uint256 public burnNonce;

    /// @notice Tracks which mint nonces have been processed (replay protection)
    mapping(uint256 => bool) public processedMintNonces;

    event Minted(address indexed user, uint256 amount, uint256 nonce);
    event Burned(address indexed user, uint256 amount, uint256 nonce);

    error NonceAlreadyProcessed(uint256 nonce);
    error ZeroAmount();

    constructor(address _wrappedToken, address relayer) {
        wrappedToken = IWrappedVaultToken(_wrappedToken);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RELAYER_ROLE, relayer);
    }

    /// @notice Mint wrapped tokens after a lock event on Chain A
    /// @param user Recipient of the wrapped tokens
    /// @param amount Number of tokens to mint
    /// @param nonce The lock nonce from Chain A (for replay protection)
    function mintWrapped(
        address user,
        uint256 amount,
        uint256 nonce
    ) external onlyRole(RELAYER_ROLE) nonReentrant {
        if (processedMintNonces[nonce]) revert NonceAlreadyProcessed(nonce);
        if (amount == 0) revert ZeroAmount();

        processedMintNonces[nonce] = true;
        wrappedToken.mint(user, amount);

        emit Minted(user, amount, nonce);
    }

    /// @notice Burn wrapped tokens to initiate bridge-back to Chain A
    /// @param amount Number of tokens to burn
    function burn(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 nonce = burnNonce++;
        wrappedToken.burn(msg.sender, amount);

        emit Burned(msg.sender, amount, nonce);
    }
}
