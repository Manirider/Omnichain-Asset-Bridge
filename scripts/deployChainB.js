const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  const relayerAddress = deployer.address;

  console.log("[Deploy ChainB] Deployer:", deployer.address);

  // 1. Deploy BridgeMint first (WrappedVaultToken needs its address)
  //    We use a two-step: deploy WrappedVaultToken with a temp address, then deploy BridgeMint,
  //    then grant role. Alternatively, predict the address. Here we deploy BridgeMint with a
  //    placeholder, then set up. Simpler approach: deploy WrappedVaultToken first with deployer
  //    as bridge, deploy BridgeMint, then transfer the BRIDGE_ROLE.

  // Deploy WrappedVaultToken with deployer as temporary bridge
  const WrappedVaultToken = await ethers.getContractFactory(
    "contracts/chainB/WrappedVaultToken.sol:WrappedVaultToken"
  );
  const wrappedToken = await WrappedVaultToken.deploy(deployer.address);
  await wrappedToken.waitForDeployment();
  console.log("[Deploy ChainB] WrappedVaultToken:", await wrappedToken.getAddress());

  // 2. Deploy BridgeMint
  const BridgeMint = await ethers.getContractFactory("contracts/chainB/BridgeMint.sol:BridgeMint");
  const bridgeMint = await BridgeMint.deploy(await wrappedToken.getAddress(), relayerAddress);
  await bridgeMint.waitForDeployment();
  console.log("[Deploy ChainB] BridgeMint:", await bridgeMint.getAddress());

  // 3. Grant BRIDGE_ROLE to BridgeMint on WrappedVaultToken
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  await wrappedToken.grantRole(BRIDGE_ROLE, await bridgeMint.getAddress());
  console.log("[Deploy ChainB] Granted BRIDGE_ROLE to BridgeMint");

  // Revoke deployer's BRIDGE_ROLE (security: only BridgeMint should mint/burn)
  await wrappedToken.revokeRole(BRIDGE_ROLE, deployer.address);
  console.log("[Deploy ChainB] Revoked deployer BRIDGE_ROLE");

  // 4. Deploy GovernanceVoting
  const GovernanceVoting = await ethers.getContractFactory(
    "contracts/chainB/GovernanceVoting.sol:GovernanceVoting"
  );
  const governance = await GovernanceVoting.deploy(await wrappedToken.getAddress());
  await governance.waitForDeployment();
  console.log("[Deploy ChainB] GovernanceVoting:", await governance.getAddress());

  // Save deployment addresses
  const addresses = {
    wrappedVaultToken: await wrappedToken.getAddress(),
    bridgeMint: await bridgeMint.getAddress(),
    governanceVoting: await governance.getAddress(),
    deployer: deployer.address,
  };

  const outDir = path.resolve(__dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "chainB.json"),
    JSON.stringify(addresses, null, 2)
  );

  console.log("[Deploy ChainB] Addresses saved to deployments/chainB.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
