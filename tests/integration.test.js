/**
 * Integration Test Suite
 *
 * Runs against live local chains (Chain A on 8545, Chain B on 9545).
 * Tests the full lock → mint → burn → unlock flow with the relayer.
 *
 * Usage: node tests/integration.test.js
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ABI fragments
const VaultTokenABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
];

const BridgeLockABI = [
  "function lock(uint256)",
  "function lockNonce() view returns (uint256)",
  "function paused() view returns (bool)",
  "event Locked(address indexed user, uint256 amount, uint256 nonce)",
];

const BridgeMintABI = [
  "function burn(uint256)",
  "function burnNonce() view returns (uint256)",
  "event Burned(address indexed user, uint256 amount, uint256 nonce)",
];

const WrappedTokenABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

const GovernanceABI = [
  "function createProposal(string, bytes) returns (uint256)",
  "function vote(uint256, bool)",
  "function executeProposal(uint256)",
  "function proposalCount() view returns (uint256)",
  "event ProposalPassed(uint256 indexed proposalId, bytes data)",
];

const AMOUNT = ethers.parseEther("100");
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ||
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

let providerA, providerB, walletA, walletB;
let vaultToken, bridgeLock, wrappedToken, bridgeMint, governance;
let passed = 0;
let failed = 0;

function log(msg) {
  console.log(`[IntegrationTest] ${msg}`);
}

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
    return false;
  }
  console.log(`  PASS: ${msg}`);
  passed++;
  return true;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mineBlocks(provider, count) {
  for (let i = 0; i < count; i++) {
    await provider.send("evm_mine", []);
  }
}

async function setup() {
  const chainARpc = process.env.CHAIN_A_RPC_URL || "http://localhost:8545";
  const chainBRpc = process.env.CHAIN_B_RPC_URL || "http://localhost:9545";

  providerA = new ethers.JsonRpcProvider(chainARpc);
  providerB = new ethers.JsonRpcProvider(chainBRpc);
  walletA = new ethers.Wallet(PRIVATE_KEY, providerA);
  walletB = new ethers.Wallet(PRIVATE_KEY, providerB);

  const deployDir = path.resolve(__dirname, "..", "deployments");
  const addrA = JSON.parse(fs.readFileSync(path.join(deployDir, "chainA.json"), "utf8"));
  const addrB = JSON.parse(fs.readFileSync(path.join(deployDir, "chainB.json"), "utf8"));

  vaultToken = new ethers.Contract(addrA.vaultToken, VaultTokenABI, walletA);
  bridgeLock = new ethers.Contract(addrA.bridgeLock, BridgeLockABI, walletA);
  wrappedToken = new ethers.Contract(addrB.wrappedVaultToken, WrappedTokenABI, walletB);
  bridgeMint = new ethers.Contract(addrB.bridgeMint, BridgeMintABI, walletB);
  governance = new ethers.Contract(addrB.governanceVoting, GovernanceABI, walletB);

  log("Contracts loaded");
}

// Test 1: Lock → Mint flow
async function testLockToMint() {
  log("\n--- Test 1: Lock → Mint Flow ---");

  // Approve tokens
  await (await vaultToken.approve(await bridgeLock.getAddress(), ethers.MaxUint256)).wait();

  const wrappedBefore = await wrappedToken.balanceOf(walletB.address);
  const nonceBefore = await bridgeLock.lockNonce();

  // Lock tokens
  const tx = await bridgeLock.lock(AMOUNT);
  await tx.wait();
  log(`Locked ${ethers.formatEther(AMOUNT)} VLT (nonce: ${nonceBefore})`);

  // Mine blocks for confirmation
  await mineBlocks(providerA, 5);
  await mineBlocks(providerB, 5);

  // Wait for relayer to process
  log("Waiting for relayer to mint...");
  await sleep(10000);

  const wrappedAfter = await wrappedToken.balanceOf(walletB.address);
  assert(
    wrappedAfter - wrappedBefore === AMOUNT,
    `Wrapped balance increased by ${ethers.formatEther(AMOUNT)}`
  );
}

// Test 2: Burn → Unlock flow
async function testBurnToUnlock() {
  log("\n--- Test 2: Burn → Unlock Flow ---");

  const vaultBefore = await vaultToken.balanceOf(walletA.address);

  // Burn wrapped tokens
  const tx = await bridgeMint.burn(AMOUNT);
  await tx.wait();
  log(`Burned ${ethers.formatEther(AMOUNT)} wVLT`);

  // Mine blocks
  await mineBlocks(providerA, 5);
  await mineBlocks(providerB, 5);

  // Wait for relayer
  log("Waiting for relayer to unlock...");
  await sleep(10000);

  const vaultAfter = await vaultToken.balanceOf(walletA.address);
  assert(
    vaultAfter - vaultBefore === AMOUNT,
    `VaultToken balance increased by ${ethers.formatEther(AMOUNT)}`
  );
}

// Test 3: Supply invariant
async function testSupplyInvariant() {
  log("\n--- Test 3: Supply Invariant ---");

  const lockedBalance = await vaultToken.balanceOf(await bridgeLock.getAddress());
  const wrappedSupply = await wrappedToken.totalSupply();

  assert(
    lockedBalance === wrappedSupply,
    `Invariant: locked (${ethers.formatEther(lockedBalance)}) == totalSupply (${ethers.formatEther(wrappedSupply)})`
  );
}

// Test 4: Governance pause flow
async function testGovernancePause() {
  log("\n--- Test 4: Governance Pause Flow ---");

  // First lock some tokens to have voting power
  await (await vaultToken.approve(await bridgeLock.getAddress(), ethers.MaxUint256)).wait();
  await (await bridgeLock.lock(AMOUNT)).wait();
  await mineBlocks(providerA, 5);
  await mineBlocks(providerB, 5);
  await sleep(10000);

  // Create proposal to pause bridge
  const govIface = new ethers.Interface(["function pauseBridge()"]);
  const actionData = govIface.encodeFunctionData("pauseBridge");

  const tx1 = await governance.createProposal("Emergency pause", actionData);
  await tx1.wait();
  log("Proposal created");

  // Vote
  const tx2 = await governance.vote(0, true);
  await tx2.wait();
  log("Voted in favor");

  // Mine past voting period
  await mineBlocks(providerB, 12);

  // Execute proposal
  const tx3 = await governance.executeProposal(0);
  await tx3.wait();
  log("Proposal executed");

  // Mine and wait for relayer
  await mineBlocks(providerA, 5);
  await mineBlocks(providerB, 5);
  await sleep(10000);

  // Check bridge is paused
  const paused = await bridgeLock.paused();
  assert(paused === true, "Bridge is paused after governance vote");

  // Verify lock() reverts
  try {
    await bridgeLock.lock(AMOUNT);
    assert(false, "lock() should revert when paused");
  } catch (err) {
    assert(true, "lock() reverts when bridge is paused");
  }
}

async function main() {
  try {
    await setup();
    await testLockToMint();
    await testBurnToUnlock();
    await testSupplyInvariant();
    await testGovernancePause();

    log(`\n========================================`);
    log(`Results: ${passed} passed, ${failed} failed`);
    log(`========================================`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("[IntegrationTest] Fatal error:", err);
    process.exit(1);
  }
}

main();
