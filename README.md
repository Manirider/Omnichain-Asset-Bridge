# Omnichain Asset Bridge with Governance Recovery

A production-quality, two-chain local asset bridge with cross-chain governance, crash recovery, and Docker orchestration. Built to DeFi infrastructure standards using the Lock/Mint and Burn/Unlock pattern.

## Overview

This system bridges `VaultToken (VLT)` from **Chain A (Settlement, chainId 1111)** to **Chain B (Execution, chainId 2222)** as `WrappedVaultToken (wVLT)`, and back. A Node.js relayer watches both chains for events, enforces confirmation depth, persists state in SQLite, and recovers automatically after crashes. Token-weighted governance on Chain B can trigger emergency pause on Chain A through the relayer.

### Components

| Component | Role |
|---|---|
| **BridgeLock** (Chain A) | Holds locked VLT; emits `Locked`; releases via `unlock()` |
| **BridgeMint** (Chain B) | Mints/burns wVLT; emits `Burned`; relayer calls `mintWrapped()` |
| **GovernanceVoting** (Chain B) | Proposal creation, token-weighted voting, execution |
| **GovernanceEmergency** (Chain A) | Receives relayed governance actions; pauses bridge |
| **Relayer** | Event listener, confirmation poller, retry engine, SQLite persistence |
| **Docker Compose** | Orchestrates two Hardhat nodes + relayer with health checks |

## Tech Stack

- **Solidity 0.8.24** with OpenZeppelin 5.x (AccessControl, Pausable, ReentrancyGuard, SafeERC20)
- **Hardhat** for compilation, local nodes (chainId 1111 / 2222), and testing
- **Node.js** with **Ethers.js v6** for the relayer service
- **SQLite** (better-sqlite3, WAL mode) for durable event tracking
- **Docker & Docker Compose** for deterministic multi-chain orchestration

## Architecture

### Lock and Mint (Chain A to Chain B)

```
User ──lock(amount)──► BridgeLock (Chain A)
                           │ Locked(user, amount, nonce)
                           ▼
                       Relayer (waits for CONFIRMATION_DEPTH blocks)
                           │ mintWrapped(user, amount, nonce)
                           ▼
                       BridgeMint (Chain B) ──mint──► wVLT to User
```

1. User approves and calls `BridgeLock.lock(amount)`.
2. Tokens transfer into the vault; `Locked(user, amount, nonce)` is emitted.
3. Relayer detects the event, polls until `currentBlock - eventBlock >= CONFIRMATION_DEPTH`.
4. Relayer calls `BridgeMint.mintWrapped(user, amount, nonce)` on Chain B.
5. wVLT is minted 1:1 to the user on Chain B.

### Burn and Unlock (Chain B to Chain A)

```
User ──burn(amount)──► BridgeMint (Chain B)
                           │ Burned(user, amount, nonce)
                           ▼
                       Relayer (waits for confirmations)
                           │ unlock(user, amount, nonce)
                           ▼
                       BridgeLock (Chain A) ──transfer──► VLT to User
```

1. User calls `BridgeMint.burn(amount)`.
2. wVLT is destroyed; `Burned(user, amount, nonce)` is emitted.
3. Relayer detects, confirms, and calls `BridgeLock.unlock(user, amount, nonce)`.
4. Original VLT is released back to the user on Chain A.

### Governance Emergency Pause

```
Proposal (Chain B) ──vote──► GovernanceVoting ──execute──► ProposalPassed(data)
                                                               │
                                                           Relayer
                                                               │ pauseBridge()
                                                               ▼
                                                GovernanceEmergency (Chain A)
                                                               │ pause()
                                                               ▼
                                                     BridgeLock is paused
```

1. wVLT holder creates a proposal with `pauseBridge()` selector as data.
2. Token-weighted voting occurs over a voting period (10 blocks).
3. After the deadline, anyone calls `executeProposal()` — emits `ProposalPassed`.
4. Relayer detects the event, decodes the function selector, and calls `GovernanceEmergency.pauseBridge()` on Chain A.
5. `BridgeLock` enters paused state; `lock()` reverts until an admin calls `unpause()`.

## Security Features

### Replay Protection

Both contracts maintain `mapping(uint256 => bool)` for processed nonces. The relayer also stores every processed nonce in SQLite. A duplicate nonce reverts on-chain with `NonceAlreadyProcessed`.

### Idempotency

The relayer checks both the SQLite `processed_events` table and on-chain nonce mappings before submitting transactions. Even if the relayer restarts mid-flight, the same event will not be double-processed.

### Confirmation Depth

Events are only acted upon once `currentBlock - eventBlock >= CONFIRMATION_DEPTH` (default: 3). This protects against chain reorganizations invalidating relayed actions.

### Access Control (RBAC)

- `RELAYER_ROLE`: Required for `unlock()`, `pause()`, `mintWrapped()`, and `pauseBridge()`.
- `BRIDGE_ROLE`: Required for wVLT `mint()` and `burn()` (only BridgeMint holds this).
- `DEFAULT_ADMIN_ROLE`: Can `unpause()` the bridge and manage roles.

### Reentrancy Protection

All state-mutating bridge functions use OpenZeppelin's `ReentrancyGuard`.

### SafeERC20

Token transfers use `SafeERC20` to handle non-standard ERC20 implementations safely.

## Failure Handling

### Transaction Retries

Every relayer transaction is attempted up to 3 times with a 2-second delay between attempts. Failures are logged at `CRITICAL` level.

### RPC Disconnect Recovery

On startup, the relayer polls each RPC endpoint up to 30 times (60 seconds) before giving up. The Docker Compose `restart: on-failure` policy handles transient outages.

### Crash Recovery

The relayer persists two things in SQLite:

1. **`processed_events`** — every successfully relayed nonce, chain, and tx hash.
2. **`block_cursors`** — the last scanned block number per event type.

On restart, the relayer reads cursors and calls `queryFilter(fromBlock, toBlock)` to replay any missed events. Combined with on-chain nonce checks, this guarantees exactly-once delivery semantics.

### Container Restarts

Docker volumes (`relayer-data`) persist the SQLite database across container restarts. The relayer service has `restart: on-failure`.

## Governance Mechanism

`GovernanceVoting` on Chain B provides:

- **Proposal creation**: Any wVLT holder can propose an action with a description and encoded calldata.
- **Token-weighted voting**: Vote weight equals `wVLT.balanceOf(voter)` at vote time.
- **Quorum**: Minimum 1 wei of votes for (configurable).
- **Voting period**: 10 blocks (configurable).
- **Execution**: After deadline, if `votesFor > votesAgainst` and quorum met, anyone can call `executeProposal()`.
- **Cross-chain relay**: The `ProposalPassed` event carries the action data. The relayer decodes the function selector and dispatches to the appropriate Chain A contract.

Currently supported governance action: `pauseBridge()` (selector `0x6b9a13e3`).

## Supply Invariant

The system enforces:

```
VaultToken.balanceOf(BridgeLock) == WrappedVaultToken.totalSupply()
```

Every wVLT in circulation is backed 1:1 by a locked VLT. This invariant is validated in dedicated tests across lock, mint, burn, unlock, and round-trip scenarios.

## Getting Started

### Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for local development and testing)

### Run with Docker

```bash
cp .env.example .env
docker-compose up --build
```

This starts three services:

| Service | Endpoint | ChainId |
|---|---|---|
| `chain-a` | `http://localhost:8545` | 1111 |
| `chain-b` | `http://localhost:9545` | 2222 |
| `relayer` | (internal) | — |

Contracts deploy automatically. The relayer waits for both chains to be healthy before starting.

### Local Development

```bash
npm install
npm run compile
```

### Environment Variables

See [.env.example](.env.example) for all configuration options:

| Variable | Default | Description |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Hardhat account #0 | Deployer and relayer key |
| `CHAIN_A_RPC_URL` | `http://localhost:8545` | Chain A RPC endpoint |
| `CHAIN_B_RPC_URL` | `http://localhost:9545` | Chain B RPC endpoint |
| `CONFIRMATION_DEPTH` | `3` | Blocks to wait before processing |
| `DB_PATH` | `./relayer/data/relayer.db` | SQLite database path |

## Testing

### Unit Tests (Hardhat)

```bash
npm test
```

Runs 28 tests covering:

- **Chain A**: lock, unlock, pause/unpause, access control, zero-amount reverts
- **Chain B**: mintWrapped, burn, governance proposals, voting, execution
- **Replay Protection**: duplicate nonce reverts on both chains
- **Supply Invariant**: zero state, lock+mint, multi-cycle, round-trip, partial unlock
- **Governance Flow**: proposal lifecycle, GovernanceEmergency pause, access control

### Integration Tests (requires running chains + relayer)

```bash
# Lock → Mint, Burn → Unlock, Invariant, Governance Pause
node tests/integration.test.js

# Crash recovery simulation
node tests/recovery.test.js
```

## Project Structure

```
contracts/
  chainA/
    VaultToken.sol             # ERC20 underlying asset
    BridgeLock.sol             # Lock vault with replay protection & pause
    GovernanceEmergency.sol    # Cross-chain emergency pause receiver
  chainB/
    WrappedVaultToken.sol      # Bridged ERC20 (mint/burn restricted)
    BridgeMint.sol             # Mint controller with replay protection
    GovernanceVoting.sol       # Token-weighted governance
relayer/
  src/
    index.js                   # Entry point, RPC setup, orchestration
    db/
      index.js                 # SQLite schema, queries, block cursors
    listeners/
      lockListener.js          # Chain A Locked → Chain B mintWrapped
      burnListener.js          # Chain B Burned → Chain A unlock
      governanceListener.js    # Chain B ProposalPassed → Chain A pause
scripts/
  deployChainA.js              # Deploy & configure Chain A contracts
  deployChainB.js              # Deploy & configure Chain B contracts
tests/
  chainA.test.js               # BridgeLock + GovernanceEmergency unit tests
  chainB.test.js               # BridgeMint + GovernanceVoting unit tests
  governance.test.js           # End-to-end governance flow
  integration.test.js          # Cross-chain integration (needs live chains)
  invariant.test.js            # Supply invariant verification
  recovery.test.js             # Crash recovery simulation
  replay.test.js               # Replay protection verification
docker/
  start-chain-a.sh             # Chain A node startup + deployment
  start-chain-b.sh             # Chain B node startup + deployment
  start-relayer.sh             # Wait for deployments, start relayer
docker-compose.yml             # Multi-service orchestration
Dockerfile                     # Node.js + Hardhat build image
.env.example                   # Environment configuration template
architecture.md                # Detailed technical architecture
```

## Author

MANIKANTA SURYASAI
AIML ENGINEER AND BLOCKCHAIN DEVELOPER
