const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Replay Protection Test
 * 
 * Verifies that:
 * 1. BridgeMint.mintWrapped reverts if same nonce is used twice
 * 2. BridgeLock.unlock reverts if same nonce is used twice
 */
describe("Replay Protection", function () {
  let vaultToken, bridgeLock, wrappedToken, bridgeMint;
  let deployer, relayer, user;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const AMOUNT = ethers.parseEther("100");

  beforeEach(async function () {
    [deployer, relayer, user] = await ethers.getSigners();

    // Chain A
    const VaultToken = await ethers.getContractFactory("contracts/chainA/VaultToken.sol:VaultToken");
    vaultToken = await VaultToken.deploy(INITIAL_SUPPLY);

    const BridgeLock = await ethers.getContractFactory("contracts/chainA/BridgeLock.sol:BridgeLock");
    bridgeLock = await BridgeLock.deploy(await vaultToken.getAddress(), relayer.address);

    // Chain B
    const WrappedVaultToken = await ethers.getContractFactory(
      "contracts/chainB/WrappedVaultToken.sol:WrappedVaultToken"
    );
    wrappedToken = await WrappedVaultToken.deploy(deployer.address);

    const BridgeMint = await ethers.getContractFactory("contracts/chainB/BridgeMint.sol:BridgeMint");
    bridgeMint = await BridgeMint.deploy(await wrappedToken.getAddress(), relayer.address);

    const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
    await wrappedToken.grantRole(BRIDGE_ROLE, await bridgeMint.getAddress());
    await wrappedToken.revokeRole(BRIDGE_ROLE, deployer.address);

    // Setup: BridgeLock needs tokens to unlock
    await vaultToken.transfer(await bridgeLock.getAddress(), INITIAL_SUPPLY / 2n);
  });

  it("should revert when minting with a duplicate nonce on Chain B", async function () {
    const nonce = 42;
    
    // First mint successful
    await bridgeMint.connect(relayer).mintWrapped(user.address, AMOUNT, nonce);
    
    // Second mint with same nonce fails
    await expect(
      bridgeMint.connect(relayer).mintWrapped(user.address, AMOUNT, nonce)
    ).to.be.revertedWithCustomError(bridgeMint, "NonceAlreadyProcessed");
  });

  it("should revert when unlocking with a duplicate nonce on Chain A", async function () {
    const nonce = 99;
    
    // First unlock successful
    await bridgeLock.connect(relayer).unlock(user.address, AMOUNT, nonce);
    
    // Second unlock with same nonce fails
    await expect(
      bridgeLock.connect(relayer).unlock(user.address, AMOUNT, nonce)
    ).to.be.revertedWithCustomError(bridgeLock, "NonceAlreadyProcessed");
  });
});
