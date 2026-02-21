require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Determine which chain ID to use when running `hardhat node`
// Set via HARDHAT_CHAIN_ID env var in Docker containers
const localChainId = parseInt(process.env.HARDHAT_CHAIN_ID || "31337", 10);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    tests: "./tests",
  },
  networks: {
    hardhat: {
      chainId: localChainId,
    },
    chainA: {
      url: process.env.CHAIN_A_RPC_URL || "http://localhost:8545",
      chainId: 1111,
      accounts: [
        process.env.DEPLOYER_PRIVATE_KEY ||
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ],
    },
    chainB: {
      url: process.env.CHAIN_B_RPC_URL || "http://localhost:9545",
      chainId: 2222,
      accounts: [
        process.env.DEPLOYER_PRIVATE_KEY ||
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ],
    },
  },
};
