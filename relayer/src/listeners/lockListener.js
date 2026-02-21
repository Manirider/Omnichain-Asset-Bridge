const { ethers } = require("ethers");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Listens for Locked events on Chain A's BridgeLock contract.
 * When detected (and confirmed), calls mintWrapped on Chain B's BridgeMint.
 */
class LockListener {
  constructor({ bridgeLock, bridgeMint, providerA, db, confirmationDepth, logger }) {
    this.bridgeLock = bridgeLock;
    this.bridgeMint = bridgeMint;
    this.providerA = providerA;
    this.db = db;
    this.confirmationDepth = confirmationDepth;
    this.log = logger;
  }

  /** Recover missed Locked events since last known block */
  async recoverMissedEvents() {
    const lastBlock = this.db.getLastBlock("chainA_lock");
    const currentBlock = await this.providerA.getBlockNumber();

    if (lastBlock >= currentBlock) return;

    this.log(`[Recovery] Scanning Chain A blocks ${lastBlock + 1} → ${currentBlock} for Locked events`);

    const events = await this.bridgeLock.queryFilter(
      this.bridgeLock.filters.Locked(),
      lastBlock + 1,
      currentBlock
    );

    for (const event of events) {
      await this._handleEvent(event, currentBlock);
    }

    this.db.setLastBlock("chainA_lock", currentBlock);
  }

  /** Start live listening for Locked events */
  startListening() {
    this.bridgeLock.on("Locked", async (user, amount, nonce, event) => {
      try {
        // ethers v6: the last arg is a ContractEventPayload; .log gives the EventLog
        const eventLog = event.log;
        await this._waitForConfirmation(eventLog);
      } catch (err) {
        this.log(`[Listener] Error handling Locked event: ${err.message}`);
      }
    });
    this.log("[Listener] Watching Chain A for Locked events");
  }

  /**
   * Poll until the event's block has enough confirmations, then process it.
   * Uses a proper async loop instead of fire-and-forget setTimeout.
   */
  async _waitForConfirmation(eventLog) {
    const targetBlock = eventLog.blockNumber + this.confirmationDepth;

    while (true) {
      const currentBlock = await this.providerA.getBlockNumber();
      if (currentBlock >= targetBlock) {
        await this._handleEvent(eventLog, currentBlock);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async _handleEvent(event, currentBlock) {
    const log = event;
    const parsed = this.bridgeLock.interface.parseLog({
      topics: log.topics,
      data: log.data,
    });

    const user = parsed.args.user;
    const amount = parsed.args.amount;
    const nonce = Number(parsed.args.nonce);

    // Confirmation check
    if (currentBlock - log.blockNumber < this.confirmationDepth) {
      this.log(`[Listener] Nonce ${nonce} not yet confirmed (${currentBlock - log.blockNumber}/${this.confirmationDepth})`);
      return;
    }

    // Replay check
    if (this.db.isProcessed(nonce, "chainA", "Locked")) {
      this.log(`[Listener] Nonce ${nonce} already processed, skipping`);
      return;
    }

    this.log(`[Relayer] Processing nonce ${nonce} — Locked(${user}, ${ethers.formatEther(amount)} VLT)`);

    // Mint on Chain B with retry
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const tx = await this.bridgeMint.mintWrapped(user, amount, nonce);
        const receipt = await tx.wait();

        this.db.markProcessed(nonce, "chainA", receipt.hash, "Locked");
        this.db.setLastBlock("chainA_lock", log.blockNumber);

        this.log(`[Relayer] Mint successful — nonce ${nonce}, tx: ${receipt.hash}`);
        return;
      } catch (err) {
        this.log(`[Relayer] Mint attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        } else {
          this.log(`[Relayer] CRITICAL — Failed to mint for nonce ${nonce} after ${MAX_RETRIES} attempts`);
        }
      }
    }
  }
}

module.exports = LockListener;
