require("dotenv").config();
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

const RelayerDB = require("./db");
const LockListener = require("./listeners/lockListener");
const BurnListener = require("./listeners/burnListener");
const GovernanceListener = require("./listeners/governanceListener");

// -- ABI fragments (only the events and functions we need) --
const BridgeLockABI = [
  "event Locked(address indexed user, uint256 amount, uint256 nonce)",
  "event Unlocked(address indexed user, uint256 amount, uint256 nonce)",
  "function unlock(address user, uint256 amount, uint256 nonce)",
  "function pause()",
];

const BridgeMintABI = [
  "event Minted(address indexed user, uint256 amount, uint256 nonce)",
  "event Burned(address indexed user, uint256 amount, uint256 nonce)",
  "function mintWrapped(address user, uint256 amount, uint256 nonce)",
];

const GovernanceVotingABI = [
  "event ProposalPassed(uint256 indexed proposalId, bytes data)",
];

const GovernanceEmergencyABI = [
  "function pauseBridge()",
];

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${msg}`);
}

async function waitForRpc(url, name, maxRetries = 30) {
  const provider = new ethers.JsonRpcProvider(url);
  for (let i = 0; i < maxRetries; i++) {
    try {
      await provider.getBlockNumber();
      log(`[Init] ${name} RPC ready`);
      return provider;
    } catch {
      log(`[Init] Waiting for ${name} RPC... (${i + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`${name} RPC not available after ${maxRetries} retries`);
}

async function loadDeployments() {
  // Wait for deployment files to exist (deployer may still be running)
  const chainAPath = path.resolve(process.env.DEPLOYMENTS_PATH || "./deployments", "chainA.json");
  const chainBPath = path.resolve(process.env.DEPLOYMENTS_PATH || "./deployments", "chainB.json");

  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(chainAPath) && fs.existsSync(chainBPath)) {
      const chainA = JSON.parse(fs.readFileSync(chainAPath, "utf8"));
      const chainB = JSON.parse(fs.readFileSync(chainBPath, "utf8"));
      return { chainA, chainB };
    }
    log(`[Init] Waiting for deployment files... (${i + 1}/60)`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Deployment files not found");
}

async function main() {
  log("[Relayer] Starting Omnichain Bridge Relayer");

  // Config
  const chainARpc = process.env.CHAIN_A_RPC_URL || "http://localhost:8545";
  const chainBRpc = process.env.CHAIN_B_RPC_URL || "http://localhost:9545";
  const confirmationDepth = parseInt(process.env.CONFIRMATION_DEPTH || "3", 10);
  const dbPath = process.env.DB_PATH || "./relayer/data/relayer.db";
  const privateKey =
    process.env.DEPLOYER_PRIVATE_KEY ||
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

  // Connect to chains
  const providerA = await waitForRpc(chainARpc, "Chain A");
  const providerB = await waitForRpc(chainBRpc, "Chain B");

  const walletA = new ethers.Wallet(privateKey, providerA);
  const walletB = new ethers.Wallet(privateKey, providerB);

  log(`[Init] Relayer address: ${walletA.address}`);
  log(`[Init] Confirmation depth: ${confirmationDepth}`);

  // Load deployment addresses
  const { chainA: addrA, chainB: addrB } = await loadDeployments();
  log(`[Init] Chain A contracts: BridgeLock=${addrA.bridgeLock}, GovEmergency=${addrA.governanceEmergency}`);
  log(`[Init] Chain B contracts: BridgeMint=${addrB.bridgeMint}, Governance=${addrB.governanceVoting}`);

  // Create contract instances
  const bridgeLock = new ethers.Contract(addrA.bridgeLock, BridgeLockABI, walletA);
  const bridgeMint = new ethers.Contract(addrB.bridgeMint, BridgeMintABI, walletB);
  const governance = new ethers.Contract(addrB.governanceVoting, GovernanceVotingABI, providerB);
  const govEmergency = new ethers.Contract(addrA.governanceEmergency, GovernanceEmergencyABI, walletA);

  // Initialize SQLite
  const db = new RelayerDB(dbPath);
  log(`[Init] SQLite database ready at ${dbPath}`);

  // Create listeners
  const lockListener = new LockListener({
    bridgeLock: new ethers.Contract(addrA.bridgeLock, BridgeLockABI, providerA),
    bridgeMint,
    providerA,
    db,
    confirmationDepth,
    logger: log,
  });

  const burnListener = new BurnListener({
    bridgeMint: new ethers.Contract(addrB.bridgeMint, BridgeMintABI, providerB),
    bridgeLock,
    providerB,
    db,
    confirmationDepth,
    logger: log,
  });

  const governanceListener = new GovernanceListener({
    governance,
    govEmergency,
    providerB,
    db,
    confirmationDepth,
    logger: log,
  });

  // Phase 1: Crash recovery — process any events missed while offline
  log("[Relayer] Starting crash recovery...");
  await lockListener.recoverMissedEvents();
  await burnListener.recoverMissedEvents();
  await governanceListener.recoverMissedEvents();
  log("[Relayer] Crash recovery complete");

  // Phase 2: Start live event listeners
  lockListener.startListening();
  burnListener.startListening();
  governanceListener.startListening();

  log("[Relayer] All listeners active — bridge operational");

  // Keep alive + periodic block cursor update
  setInterval(async () => {
    try {
      const blockA = await providerA.getBlockNumber();
      const blockB = await providerB.getBlockNumber();
      log(`[Heartbeat] Chain A block: ${blockA}, Chain B block: ${blockB}`);
    } catch (err) {
      log(`[Heartbeat] Error: ${err.message}`);
    }
  }, 30000);

  // Graceful shutdown
  process.on("SIGINT", () => {
    log("[Relayer] Shutting down...");
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    log("[Relayer] Shutting down...");
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[Relayer] Fatal error:", err);
  process.exit(1);
});
