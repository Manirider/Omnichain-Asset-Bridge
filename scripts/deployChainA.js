const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  const relayerAddress = deployer.address; // Relayer uses same key in local dev

  console.log("[Deploy ChainA] Deployer:", deployer.address);

  // 1. Deploy VaultToken with 1M initial supply
  const initialSupply = ethers.parseEther("1000000");
  const VaultToken = await ethers.getContractFactory("contracts/chainA/VaultToken.sol:VaultToken");
  const vaultToken = await VaultToken.deploy(initialSupply);
  await vaultToken.waitForDeployment();
  console.log("[Deploy ChainA] VaultToken:", await vaultToken.getAddress());

  // 2. Deploy BridgeLock
  const BridgeLock = await ethers.getContractFactory("contracts/chainA/BridgeLock.sol:BridgeLock");
  const bridgeLock = await BridgeLock.deploy(await vaultToken.getAddress(), relayerAddress);
  await bridgeLock.waitForDeployment();
  console.log("[Deploy ChainA] BridgeLock:", await bridgeLock.getAddress());

  // 3. Deploy GovernanceEmergency
  const GovernanceEmergency = await ethers.getContractFactory(
    "contracts/chainA/GovernanceEmergency.sol:GovernanceEmergency"
  );
  const govEmergency = await GovernanceEmergency.deploy(
    await bridgeLock.getAddress(),
    relayerAddress
  );
  await govEmergency.waitForDeployment();
  console.log("[Deploy ChainA] GovernanceEmergency:", await govEmergency.getAddress());

  // 4. Grant RELAYER_ROLE to GovernanceEmergency on BridgeLock
  //    so GovernanceEmergency.pauseBridge() can call BridgeLock.pause()
  const RELAYER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RELAYER_ROLE"));
  await bridgeLock.grantRole(RELAYER_ROLE, await govEmergency.getAddress());
  console.log("[Deploy ChainA] Granted RELAYER_ROLE to GovernanceEmergency on BridgeLock");

  // Save deployment addresses
  const addresses = {
    vaultToken: await vaultToken.getAddress(),
    bridgeLock: await bridgeLock.getAddress(),
    governanceEmergency: await govEmergency.getAddress(),
    deployer: deployer.address,
  };

  const outDir = path.resolve(__dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "chainA.json"),
    JSON.stringify(addresses, null, 2)
  );

  console.log("[Deploy ChainA] Addresses saved to deployments/chainA.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
