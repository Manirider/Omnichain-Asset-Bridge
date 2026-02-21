const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Governance Flow Test
 * 
 * Verifies the end-to-end governance lifecycle:
 * 1. Create proposal on Chain B to pause bridge
 * 2. Vote and meet quorum
 * 3. Execute proposal on Chain B
 * 4. Verify pause intent (The relayer usually bridges this, here we test the contract logic)
 */
describe("Governance Flow", function () {
    let vaultToken, bridgeLock, wrappedToken, bridgeMint, governance, govEmergency;
    let deployer, relayer, user;

    const INITIAL_SUPPLY = ethers.parseEther("1000000");
    const VOTING_PERIOD = 10;

    beforeEach(async function () {
        [deployer, relayer, user] = await ethers.getSigners();

        // Chain A
        const VaultToken = await ethers.getContractFactory("contracts/chainA/VaultToken.sol:VaultToken");
        vaultToken = await VaultToken.deploy(INITIAL_SUPPLY);

        const BridgeLock = await ethers.getContractFactory("contracts/chainA/BridgeLock.sol:BridgeLock");
        bridgeLock = await BridgeLock.deploy(await vaultToken.getAddress(), relayer.address);

        const GovernanceEmergency = await ethers.getContractFactory("contracts/chainA/GovernanceEmergency.sol:GovernanceEmergency");
        govEmergency = await GovernanceEmergency.deploy(await bridgeLock.getAddress(), relayer.address);

        // Grant RELAYER_ROLE to GovEmergency so it can pause BridgeLock
        const RELAYER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RELAYER_ROLE"));
        await bridgeLock.grantRole(RELAYER_ROLE, await govEmergency.getAddress());

        // Chain B
        const WrappedVaultToken = await ethers.getContractFactory("contracts/chainB/WrappedVaultToken.sol:WrappedVaultToken");
        wrappedToken = await WrappedVaultToken.deploy(deployer.address);

        const BridgeMint = await ethers.getContractFactory("contracts/chainB/BridgeMint.sol:BridgeMint");
        bridgeMint = await BridgeMint.deploy(await wrappedToken.getAddress(), relayer.address);

        const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
        await wrappedToken.grantRole(BRIDGE_ROLE, await bridgeMint.getAddress());
        await wrappedToken.revokeRole(BRIDGE_ROLE, deployer.address);

        const GovernanceVoting = await ethers.getContractFactory("contracts/chainB/GovernanceVoting.sol:GovernanceVoting");
        governance = await GovernanceVoting.deploy(await wrappedToken.getAddress());

        // Setup: User needs wVLT to vote
        await bridgeMint.connect(relayer).mintWrapped(user.address, ethers.parseEther("100"), 0);
    });

    it("should allow creating, voting, and passing a pause proposal on Chain B", async function () {
        const pauseBridgeSelector = "0x6b9a13e3"; // pauseBridge()
        const description = "Emergency Pause Bridge";

        // 1. Create Proposal
        await governance.connect(user).createProposal(description, pauseBridgeSelector);
        const proposalId = 0;

        let proposal = await governance.proposals(proposalId);
        expect(proposal.description).to.equal(description);

        // 2. Vote
        await governance.connect(user).vote(proposalId, true);

        proposal = await governance.proposals(proposalId);
        expect(proposal.votesFor).to.equal(ethers.parseEther("100"));

        // 3. Fast forward time (blocks) for voting period to end
        for (let i = 0; i < VOTING_PERIOD + 1; i++) {
            await ethers.provider.send("evm_mine");
        }

        // 4. Execute (Emits ProposalPassed)
        await expect(governance.executeProposal(proposalId))
            .to.emit(governance, "ProposalPassed")
            .withArgs(proposalId, pauseBridgeSelector);

        proposal = await governance.proposals(proposalId);
        expect(proposal.executed).to.be.true;
    });

    it("should pause BridgeLock when GovernanceEmergency calls pauseBridge", async function () {
        // Simulated Relayer action: Detecting ProposalPassed and calling Chain A
        await govEmergency.connect(relayer).pauseBridge();

        expect(await bridgeLock.paused()).to.be.true;

        // Verify lock reverts when paused
        await vaultToken.connect(user).approve(await bridgeLock.getAddress(), 100);
        await expect(bridgeLock.connect(user).lock(100))
            .to.be.revertedWithCustomError(bridgeLock, "EnforcedPause");
    });
});
