#!/bin/sh
set -e

export HARDHAT_CHAIN_ID=2222

echo "[ChainB] Starting Hardhat node on port 9545 with chainId 2222..."
npx hardhat node --hostname 0.0.0.0 --port 9545 &
NODE_PID=$!

# Wait for the node to be ready
echo "[ChainB] Waiting for node to start..."
for i in $(seq 1 30); do
  if curl -sf -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    http://localhost:9545 > /dev/null 2>&1; then
    echo "[ChainB] Node is ready"
    break
  fi
  sleep 1
done

# Deploy contracts
echo "[ChainB] Deploying contracts..."
npx hardhat run scripts/deployChainB.js --network chainB

echo "[ChainB] Deployment complete. Node running (PID: $NODE_PID)"
wait $NODE_PID
