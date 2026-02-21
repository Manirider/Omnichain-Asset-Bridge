const { ethers } = require("ethers");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Listens for Burned events on Chain B's BridgeMint contract.
 * When detected (and confirmed), calls unlock on Chain A's BridgeLock.
 */
class BurnListener {
  constructor({ bridgeMint, bridgeLock, providerB, db, confirmationDepth, logger }) {
    this.bridgeMint = bridgeMint;
    this.bridgeLock = bridgeLock;
    this.providerB = providerB;
    this.db = db;
    this.confirmationDepth = confirmationDepth;
    this.log = logger;
  }

  /** Recover missed Burned events since last known block */
  async recoverMissedEvents() {
    const lastBlock = this.db.getLastBlock("chainB_burn");
    const currentBlock = await this.providerB.getBlockNumber();

    if (lastBlock >= currentBlock) return;

    this.log(`[Recovery] Scanning Chain B blocks ${lastBlock + 1} → ${currentBlock} for Burned events`);

    const events = await this.bridgeMint.queryFilter(
      this.bridgeMint.filters.Burned(),
      lastBlock + 1,
      currentBlock
    );

    for (const event of events) {
      await this._handleEvent(event, currentBlock);
    }

    this.db.setLastBlock("chainB_burn", currentBlock);
  }

  /** Start live listening for Burned events */
  startListening() {
    this.bridgeMint.on("Burned", async (user, amount, nonce, event) => {
      try {
        // ethers v6: the last arg is a ContractEventPayload; .log gives the EventLog
        const eventLog = event.log;
        await this._waitForConfirmation(eventLog);
      } catch (err) {
        this.log(`[Listener] Error handling Burned event: ${err.message}`);
      }
    });
    this.log("[Listener] Watching Chain B for Burned events");
  }

  /**
   * Poll until the event's block has enough confirmations, then process it.
   * Uses a proper async loop instead of fire-and-forget setTimeout.
   */
  async _waitForConfirmation(eventLog) {
    const targetBlock = eventLog.blockNumber + this.confirmationDepth;

    while (true) {
      const currentBlock = await this.providerB.getBlockNumber();
      if (currentBlock >= targetBlock) {
        await this._handleEvent(eventLog, currentBlock);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async _handleEvent(event, currentBlock) {
    const log = event;
    const parsed = this.bridgeMint.interface.parseLog({
      topics: log.topics,
      data: log.data,
    });

    const user = parsed.args.user;
    const amount = parsed.args.amount;
    const nonce = Number(parsed.args.nonce);

    // Confirmation check
    if (currentBlock - log.blockNumber < this.confirmationDepth) {
      this.log(`[Listener] Burn nonce ${nonce} not yet confirmed`);
      return;
    }

    // Replay check
    if (this.db.isProcessed(nonce, "chainB", "Burned")) {
      this.log(`[Listener] Burn nonce ${nonce} already processed, skipping`);
      return;
    }

    this.log(`[Relayer] Processing burn nonce ${nonce} — Burned(${user}, ${ethers.formatEther(amount)} wVLT)`);

    // Unlock on Chain A with retry
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const tx = await this.bridgeLock.unlock(user, amount, nonce);
        const receipt = await tx.wait();

        this.db.markProcessed(nonce, "chainB", receipt.hash, "Burned");
        this.db.setLastBlock("chainB_burn", log.blockNumber);

        this.log(`[Relayer] Unlock successful — nonce ${nonce}, tx: ${receipt.hash}`);
        return;
      } catch (err) {
        this.log(`[Relayer] Unlock attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        } else {
          this.log(`[Relayer] CRITICAL — Failed to unlock for nonce ${nonce} after ${MAX_RETRIES} attempts`);
        }
      }
    }
  }
}

module.exports = BurnListener;
