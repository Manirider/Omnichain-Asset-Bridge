const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BridgeLock", function () {
  let vaultToken, bridgeLock;
  let deployer, relayer, user;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const LOCK_AMOUNT = ethers.parseEther("100");

  beforeEach(async function () {
    [deployer, relayer, user] = await ethers.getSigners();

    const VaultToken = await ethers.getContractFactory("contracts/chainA/VaultToken.sol:VaultToken");
    vaultToken = await VaultToken.deploy(INITIAL_SUPPLY);

    const BridgeLock = await ethers.getContractFactory("contracts/chainA/BridgeLock.sol:BridgeLock");
    bridgeLock = await BridgeLock.deploy(await vaultToken.getAddress(), relayer.address);

    // Transfer tokens to user for testing
    await vaultToken.transfer(user.address, ethers.parseEther("1000"));
    // User approves BridgeLock
    await vaultToken.connect(user).approve(await bridgeLock.getAddress(), ethers.MaxUint256);
  });

  describe("lock()", function () {
    it("should lock tokens and emit Locked event with auto-incremented nonce", async function () {
      await expect(bridgeLock.connect(user).lock(LOCK_AMOUNT))
        .to.emit(bridgeLock, "Locked")
        .withArgs(user.address, LOCK_AMOUNT, 0);

      await expect(bridgeLock.connect(user).lock(LOCK_AMOUNT))
        .to.emit(bridgeLock, "Locked")
        .withArgs(user.address, LOCK_AMOUNT, 1);

      expect(await vaultToken.balanceOf(await bridgeLock.getAddress())).to.equal(
        LOCK_AMOUNT * 2n
      );
    });

    it("should revert on zero amount", async function () {
      await expect(bridgeLock.connect(user).lock(0)).to.be.revertedWithCustomError(
        bridgeLock,
        "ZeroAmount"
      );
    });

    it("should revert when paused", async function () {
      await bridgeLock.connect(relayer).pause();
      await expect(bridgeLock.connect(user).lock(LOCK_AMOUNT)).to.be.revertedWithCustomError(
        bridgeLock,
        "EnforcedPause"
      );
    });
  });

  describe("unlock()", function () {
    beforeEach(async function () {
      // Lock tokens first
      await bridgeLock.connect(user).lock(LOCK_AMOUNT);
    });

    it("should unlock tokens to user", async function () {
      const balBefore = await vaultToken.balanceOf(user.address);
      await bridgeLock.connect(relayer).unlock(user.address, LOCK_AMOUNT, 0);
      const balAfter = await vaultToken.balanceOf(user.address);

      expect(balAfter - balBefore).to.equal(LOCK_AMOUNT);
    });

    it("should revert on replay (same nonce)", async function () {
      await bridgeLock.connect(relayer).unlock(user.address, LOCK_AMOUNT, 0);

      await expect(
        bridgeLock.connect(relayer).unlock(user.address, LOCK_AMOUNT, 0)
      ).to.be.revertedWithCustomError(bridgeLock, "NonceAlreadyProcessed");
    });

    it("should revert when called by non-relayer", async function () {
      await expect(
        bridgeLock.connect(user).unlock(user.address, LOCK_AMOUNT, 0)
      ).to.be.reverted;
    });
  });

  describe("pause/unpause", function () {
    it("relayer can pause", async function () {
      await bridgeLock.connect(relayer).pause();
      await expect(bridgeLock.connect(user).lock(LOCK_AMOUNT)).to.be.revertedWithCustomError(
        bridgeLock,
        "EnforcedPause"
      );
    });

    it("admin can unpause", async function () {
      await bridgeLock.connect(relayer).pause();
      await bridgeLock.connect(deployer).unpause();
      await expect(bridgeLock.connect(user).lock(LOCK_AMOUNT)).to.not.be.reverted;
    });
  });
});

describe("GovernanceEmergency", function () {
  let vaultToken, bridgeLock, govEmergency;
  let deployer, relayer, user;

  beforeEach(async function () {
    [deployer, relayer, user] = await ethers.getSigners();

    const VaultToken = await ethers.getContractFactory("contracts/chainA/VaultToken.sol:VaultToken");
    vaultToken = await VaultToken.deploy(ethers.parseEther("1000000"));

    const BridgeLock = await ethers.getContractFactory("contracts/chainA/BridgeLock.sol:BridgeLock");
    bridgeLock = await BridgeLock.deploy(await vaultToken.getAddress(), relayer.address);

    const GovernanceEmergency = await ethers.getContractFactory(
      "contracts/chainA/GovernanceEmergency.sol:GovernanceEmergency"
    );
    govEmergency = await GovernanceEmergency.deploy(
      await bridgeLock.getAddress(),
      relayer.address
    );

    // Grant RELAYER_ROLE to GovernanceEmergency on BridgeLock
    const RELAYER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RELAYER_ROLE"));
    await bridgeLock.grantRole(RELAYER_ROLE, await govEmergency.getAddress());

    // Setup user
    await vaultToken.transfer(user.address, ethers.parseEther("1000"));
    await vaultToken.connect(user).approve(await bridgeLock.getAddress(), ethers.MaxUint256);
  });

  it("relayer can pause bridge via GovernanceEmergency", async function () {
    await govEmergency.connect(relayer).pauseBridge();

    await expect(
      bridgeLock.connect(user).lock(ethers.parseEther("100"))
    ).to.be.revertedWithCustomError(bridgeLock, "EnforcedPause");
  });

  it("non-relayer cannot pause", async function () {
    await expect(govEmergency.connect(user).pauseBridge()).to.be.reverted;
  });
});
