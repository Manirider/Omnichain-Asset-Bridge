const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Supply Invariant Test
 *
 * Verifies that: VaultToken.balanceOf(BridgeLock) == WrappedVaultToken.totalSupply()
 *
 * This invariant must hold at all times — tokens locked on Chain A must equal
 * the total wrapped tokens minted on Chain B.
 */
describe("Supply Invariant", function () {
  let vaultToken, bridgeLock, wrappedToken, bridgeMint;
  let deployer, relayer, user;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const AMOUNT = ethers.parseEther("500");

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

    // Setup user
    await vaultToken.transfer(user.address, ethers.parseEther("10000"));
    await vaultToken.connect(user).approve(await bridgeLock.getAddress(), ethers.MaxUint256);
  });

  async function checkInvariant() {
    const lockedBalance = await vaultToken.balanceOf(await bridgeLock.getAddress());
    const wrappedSupply = await wrappedToken.totalSupply();
    expect(lockedBalance).to.equal(wrappedSupply, "INVARIANT VIOLATED: locked != totalSupply");
  }

  it("invariant holds initially (both zero)", async function () {
    await checkInvariant();
  });

  it("invariant holds after lock + mint (simulating relayer)", async function () {
    // User locks on Chain A
    await bridgeLock.connect(user).lock(AMOUNT);

    // Relayer mints on Chain B (simulated)
    await bridgeMint.connect(relayer).mintWrapped(user.address, AMOUNT, 0);

    await checkInvariant();
  });

  it("invariant holds after multiple lock+mint cycles", async function () {
    const amounts = [
      ethers.parseEther("100"),
      ethers.parseEther("250"),
      ethers.parseEther("75"),
    ];

    for (let i = 0; i < amounts.length; i++) {
      await bridgeLock.connect(user).lock(amounts[i]);
      await bridgeMint.connect(relayer).mintWrapped(user.address, amounts[i], i);
    }

    await checkInvariant();
  });

  it("invariant holds after lock+mint then burn+unlock (round trip)", async function () {
    // Lock + Mint
    await bridgeLock.connect(user).lock(AMOUNT);
    await bridgeMint.connect(relayer).mintWrapped(user.address, AMOUNT, 0);
    await checkInvariant();

    // Burn + Unlock
    await bridgeMint.connect(user).burn(AMOUNT);
    await bridgeLock.connect(relayer).unlock(user.address, AMOUNT, 0);
    await checkInvariant();

    // Both should be zero again
    const lockedBalance = await vaultToken.balanceOf(await bridgeLock.getAddress());
    expect(lockedBalance).to.equal(0);
  });

  it("invariant holds after partial burn+unlock", async function () {
    const halfAmount = AMOUNT / 2n;

    // Lock full amount
    await bridgeLock.connect(user).lock(AMOUNT);
    await bridgeMint.connect(relayer).mintWrapped(user.address, AMOUNT, 0);
    await checkInvariant();

    // Burn half
    await bridgeMint.connect(user).burn(halfAmount);
    await bridgeLock.connect(relayer).unlock(user.address, halfAmount, 0);
    await checkInvariant();

    // Half remains locked and minted
    const lockedBalance = await vaultToken.balanceOf(await bridgeLock.getAddress());
    expect(lockedBalance).to.equal(halfAmount);
  });
});
