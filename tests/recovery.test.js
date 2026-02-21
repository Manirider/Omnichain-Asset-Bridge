const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const RelayerDB = require("../relayer/src/db");
const LockListener = require("../relayer/src/listeners/lockListener");
require("dotenv").config();

/**
 * Recovery Test
 * 
 * Verifies that the relayer can recover missed events since its last processed block.
 * This simulates a crash and restart.
 */
async function runTest() {
    console.log("[RecoveryTest] Starting relayer recovery test...");

    // Setup RPC and Wallets
    const chainARpc = process.env.CHAIN_A_RPC_URL || "http://localhost:8545";
    const chainBRpc = process.env.CHAIN_B_RPC_URL || "http://localhost:9545";
    const providerA = new ethers.JsonRpcProvider(chainARpc);
    const providerB = new ethers.JsonRpcProvider(chainBRpc);

    const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const walletA = new ethers.Wallet(PRIVATE_KEY, providerA);
    const walletB = new ethers.Wallet(PRIVATE_KEY, providerB);

    // Load deployments
    const deployDir = path.resolve(__dirname, "..", "deployments");
    const addrA = JSON.parse(fs.readFileSync(path.join(deployDir, "chainA.json"), "utf8"));
    const addrB = JSON.parse(fs.readFileSync(path.join(deployDir, "chainB.json"), "utf8"));

    // Contract instances
    const BridgeLockABI = ["function lock(uint256)", "event Locked(address indexed user, uint256 amount, uint256 nonce)"];
    const BridgeMintABI = ["function mintWrapped(address user, uint256 amount, uint256 nonce)", "event Minted(address indexed user, uint256 amount, uint256 nonce)"];
    const VaultTokenABI = ["function approve(address, uint256)"];
    const WrappedTokenABI = ["function balanceOf(address) view returns (uint256)"];

    const bridgeLock = new ethers.Contract(addrA.bridgeLock, BridgeLockABI, walletA);
    const bridgeMint = new ethers.Contract(addrB.bridgeMint, BridgeMintABI, walletB);
    const vaultToken = new ethers.Contract(addrA.vaultToken, VaultTokenABI, walletA);
    const wrappedToken = new ethers.Contract(addrB.wrappedVaultToken, WrappedTokenABI, providerB);

    // 1. Setup DB and point it to a temp file
    const dbPath = path.resolve(__dirname, "recovery_test.db");
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const db = new RelayerDB(dbPath);

    // 2. Set the "last block" to current block before we do anything
    const startingBlock = await providerA.getBlockNumber();
    db.setLastBlock("chainA_lock", startingBlock);
    console.log(`[RecoveryTest] Relayer "last block" initialized to ${startingBlock}`);

    // 3. Perform a lock while the relayer is "offline"
    const amount = ethers.parseEther("55");
    await (await vaultToken.approve(addrA.bridgeLock, amount)).wait();
    const lockTx = await bridgeLock.lock(amount);
    const receipt = await lockTx.wait();
    console.log(`[RecoveryTest] Locked tokens in block ${receipt.blockNumber} (Relayer is offline)`);

    // 4. Mine some blocks to meet confirmation depth (3 by default)
    for (let i = 0; i < 5; i++) {
        await providerA.send("evm_mine", []);
    }
    console.log("[RecoveryTest] Mined 5 blocks for confirmation");

    // 5. Initialize LockListener and run recovery
    const listener = new LockListener({
        bridgeLock,
        bridgeMint,
        providerA,
        db,
        confirmationDepth: 1, // Set small for testing
        logger: (msg) => console.log(`  [Relayer Mock] ${msg}`)
    });

    const balanceBefore = await wrappedToken.balanceOf(walletA.address);

    console.log("[RecoveryTest] Restarting relayer (running recovery)...");
    await listener.recoverMissedEvents();

    // 6. Verify minting occurred
    const balanceAfter = await wrappedToken.balanceOf(walletA.address);
    if (balanceAfter - balanceBefore === amount) {
        console.log("[RecoveryTest] PASS: Missed event was recovered and processed!");
    } else {
        console.error("[RecoveryTest] FAIL: Balance did not increase. Recovery failed.");
        process.exit(1);
    }

    // Cleanup
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
}

runTest().catch(err => {
    console.error(err);
    process.exit(1);
});
