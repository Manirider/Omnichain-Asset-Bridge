const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BridgeMint", function () {
  let wrappedToken, bridgeMint;
  let deployer, relayer, user;

  const MINT_AMOUNT = ethers.parseEther("100");

  beforeEach(async function () {
    [deployer, relayer, user] = await ethers.getSigners();

    // Deploy WrappedVaultToken with deployer as temp bridge
    const WrappedVaultToken = await ethers.getContractFactory(
      "contracts/chainB/WrappedVaultToken.sol:WrappedVaultToken"
    );
    wrappedToken = await WrappedVaultToken.deploy(deployer.address);

    // Deploy BridgeMint
    const BridgeMint = await ethers.getContractFactory("contracts/chainB/BridgeMint.sol:BridgeMint");
    bridgeMint = await BridgeMint.deploy(await wrappedToken.getAddress(), relayer.address);

    // Grant BRIDGE_ROLE to BridgeMint
    const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
    await wrappedToken.grantRole(BRIDGE_ROLE, await bridgeMint.getAddress());
    await wrappedToken.revokeRole(BRIDGE_ROLE, deployer.address);
  });

  describe("mintWrapped()", function () {
    it("should mint wrapped tokens and emit Minted event", async function () {
      await expect(bridgeMint.connect(relayer).mintWrapped(user.address, MINT_AMOUNT, 0))
        .to.emit(bridgeMint, "Minted")
        .withArgs(user.address, MINT_AMOUNT, 0);

      expect(await wrappedToken.balanceOf(user.address)).to.equal(MINT_AMOUNT);
    });

    it("should revert on replay (same nonce)", async function () {
      await bridgeMint.connect(relayer).mintWrapped(user.address, MINT_AMOUNT, 0);

      await expect(
        bridgeMint.connect(relayer).mintWrapped(user.address, MINT_AMOUNT, 0)
      ).to.be.revertedWithCustomError(bridgeMint, "NonceAlreadyProcessed");
    });

    it("should revert when called by non-relayer", async function () {
      await expect(
        bridgeMint.connect(user).mintWrapped(user.address, MINT_AMOUNT, 0)
      ).to.be.reverted;
    });

    it("should revert on zero amount", async function () {
      await expect(
        bridgeMint.connect(relayer).mintWrapped(user.address, 0, 0)
      ).to.be.revertedWithCustomError(bridgeMint, "ZeroAmount");
    });
  });

  describe("burn()", function () {
    beforeEach(async function () {
      // Mint tokens to user first
      await bridgeMint.connect(relayer).mintWrapped(user.address, MINT_AMOUNT, 0);
    });

    it("should burn wrapped tokens and emit Burned event with auto-incremented nonce", async function () {
      await expect(bridgeMint.connect(user).burn(MINT_AMOUNT))
        .to.emit(bridgeMint, "Burned")
        .withArgs(user.address, MINT_AMOUNT, 0);

      expect(await wrappedToken.balanceOf(user.address)).to.equal(0);
    });

    it("should revert on zero amount", async function () {
      await expect(bridgeMint.connect(user).burn(0)).to.be.revertedWithCustomError(
        bridgeMint,
        "ZeroAmount"
      );
    });
  });
});

describe("GovernanceVoting", function () {
  let wrappedToken, bridgeMint, governance;
  let deployer, relayer, voter;

  const MINT_AMOUNT = ethers.parseEther("1000");

  beforeEach(async function () {
    [deployer, relayer, voter] = await ethers.getSigners();

    const WrappedVaultToken = await ethers.getContractFactory(
      "contracts/chainB/WrappedVaultToken.sol:WrappedVaultToken"
    );
    wrappedToken = await WrappedVaultToken.deploy(deployer.address);

    const BridgeMint = await ethers.getContractFactory("contracts/chainB/BridgeMint.sol:BridgeMint");
    bridgeMint = await BridgeMint.deploy(await wrappedToken.getAddress(), relayer.address);

    const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
    await wrappedToken.grantRole(BRIDGE_ROLE, await bridgeMint.getAddress());
    await wrappedToken.revokeRole(BRIDGE_ROLE, deployer.address);

    const GovernanceVoting = await ethers.getContractFactory(
      "contracts/chainB/GovernanceVoting.sol:GovernanceVoting"
    );
    governance = await GovernanceVoting.deploy(await wrappedToken.getAddress());

    // Give voter some tokens
    await bridgeMint.connect(relayer).mintWrapped(voter.address, MINT_AMOUNT, 0);
  });

  it("should create proposal, vote, and execute", async function () {
    const pauseData = governance.interface.encodeFunctionData(
      // We encode the pauseBridge() signature manually
      "executeProposal", [0]
    );
    // Actually encode pauseBridge for the GovernanceEmergency
    const govIface = new ethers.Interface(["function pauseBridge()"]);
    const actionData = govIface.encodeFunctionData("pauseBridge");

    // Create proposal
    await expect(governance.connect(voter).createProposal("Pause the bridge", actionData))
      .to.emit(governance, "ProposalCreated");

    // Vote
    await expect(governance.connect(voter).vote(0, true))
      .to.emit(governance, "Voted")
      .withArgs(0, voter.address, true, MINT_AMOUNT);

    // Mine blocks to pass voting period
    for (let i = 0; i < 11; i++) {
      await ethers.provider.send("evm_mine", []);
    }

    // Execute
    await expect(governance.connect(voter).executeProposal(0))
      .to.emit(governance, "ProposalPassed")
      .withArgs(0, actionData);
  });

  it("should revert execution if not enough votes", async function () {
    const govIface = new ethers.Interface(["function pauseBridge()"]);
    const actionData = govIface.encodeFunctionData("pauseBridge");

    await governance.connect(voter).createProposal("Pause", actionData);
    await governance.connect(voter).vote(0, false); // Vote against

    for (let i = 0; i < 11; i++) {
      await ethers.provider.send("evm_mine", []);
    }

    await expect(governance.connect(voter).executeProposal(0))
      .to.be.revertedWithCustomError(governance, "ProposalNotPassed");
  });

  it("should prevent double voting", async function () {
    const govIface = new ethers.Interface(["function pauseBridge()"]);
    const actionData = govIface.encodeFunctionData("pauseBridge");

    await governance.connect(voter).createProposal("Pause", actionData);
    await governance.connect(voter).vote(0, true);

    await expect(governance.connect(voter).vote(0, true))
      .to.be.revertedWithCustomError(governance, "AlreadyVoted");
  });
});
