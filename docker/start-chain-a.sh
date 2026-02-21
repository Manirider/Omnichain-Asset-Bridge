#!/bin/sh
set -e

export HARDHAT_CHAIN_ID=1111

echo "[ChainA] Starting Hardhat node on port 8545 with chainId 1111..."
npx hardhat node --hostname 0.0.0.0 --port 8545 &
NODE_PID=$!

# Wait for the node to be ready
echo "[ChainA] Waiting for node to start..."
for i in $(seq 1 30); do
  if curl -sf -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    http://localhost:8545 > /dev/null 2>&1; then
    echo "[ChainA] Node is ready"
    break
  fi
  sleep 1
done

# Deploy contracts
echo "[ChainA] Deploying contracts..."
npx hardhat run scripts/deployChainA.js --network chainA

echo "[ChainA] Deployment complete. Node running (PID: $NODE_PID)"
wait $NODE_PID
