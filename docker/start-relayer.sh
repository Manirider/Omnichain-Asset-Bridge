#!/bin/sh
set -e

echo "[Relayer] Waiting for deployment files..."
while [ ! -f /app/deployments/chainA.json ] || [ ! -f /app/deployments/chainB.json ]; do
  sleep 2
  echo "[Relayer] Still waiting for deployments..."
done

echo "[Relayer] Deployment files found. Starting relayer..."
node relayer/src/index.js
