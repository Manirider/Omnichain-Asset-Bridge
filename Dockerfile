FROM node:20-alpine

WORKDIR /app

# Install build tools for native modules (better-sqlite3) and curl for healthchecks
RUN apk add --no-cache python3 make g++ curl

COPY package.json package-lock.json ./
RUN npm install

COPY . .

# Compile contracts
RUN npx hardhat compile

# Create data directory for SQLite
RUN mkdir -p relayer/data

EXPOSE 8545 9545
