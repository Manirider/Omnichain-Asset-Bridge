// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BridgeLock - Locks tokens on Chain A for cross-chain bridging
/// @notice Users lock VaultTokens here; the relayer mints wrapped tokens on Chain B.
///         On the return path, the relayer calls unlock to release tokens back.
contract BridgeLock is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    IERC20 public immutable token;

    /// @notice Auto-incrementing nonce for lock operations
    uint256 public lockNonce;

    /// @notice Tracks which unlock nonces have been processed (replay protection)
    mapping(uint256 => bool) public processedUnlockNonces;

    event Locked(address indexed user, uint256 amount, uint256 nonce);
    event Unlocked(address indexed user, uint256 amount, uint256 nonce);

    error NonceAlreadyProcessed(uint256 nonce);
    error ZeroAmount();

    constructor(address _token, address relayer) {
        token = IERC20(_token);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RELAYER_ROLE, relayer);
    }

    /// @notice Lock tokens into the bridge vault
    /// @param amount Number of tokens to lock
    function lock(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 nonce = lockNonce++;
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Locked(msg.sender, amount, nonce);
    }

    /// @notice Unlock tokens back to a user (called by relayer after burn on Chain B)
    /// @param user Recipient address
    /// @param amount Number of tokens to unlock
    /// @param nonce The burn nonce from Chain B (for replay protection)
    function unlock(
        address user,
        uint256 amount,
        uint256 nonce
    ) external onlyRole(RELAYER_ROLE) nonReentrant {
        if (processedUnlockNonces[nonce]) revert NonceAlreadyProcessed(nonce);
        if (amount == 0) revert ZeroAmount();

        processedUnlockNonces[nonce] = true;
        token.safeTransfer(user, amount);

        emit Unlocked(user, amount, nonce);
    }

    /// @notice Pause the bridge (emergency stop)
    function pause() external onlyRole(RELAYER_ROLE) {
        _pause();
    }

    /// @notice Unpause the bridge
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
