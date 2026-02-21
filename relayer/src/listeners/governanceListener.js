const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Listens for ProposalPassed events on Chain B's GovernanceVoting contract.
 * When detected, relays governance actions to Chain A's GovernanceEmergency.
 */
class GovernanceListener {
  constructor({ governance, govEmergency, providerB, db, confirmationDepth, logger }) {
    this.governance = governance;
    this.govEmergency = govEmergency;
    this.providerB = providerB;
    this.db = db;
    this.confirmationDepth = confirmationDepth;
    this.log = logger;
  }

  /** Recover missed ProposalPassed events */
  async recoverMissedEvents() {
    const lastBlock = this.db.getLastBlock("chainB_governance");
    const currentBlock = await this.providerB.getBlockNumber();

    if (lastBlock >= currentBlock) return;

    this.log(`[Recovery] Scanning Chain B blocks ${lastBlock + 1} → ${currentBlock} for ProposalPassed events`);

    const events = await this.governance.queryFilter(
      this.governance.filters.ProposalPassed(),
      lastBlock + 1,
      currentBlock
    );

    for (const event of events) {
      await this._handleEvent(event, currentBlock);
    }

    this.db.setLastBlock("chainB_governance", currentBlock);
  }

  /** Start live listening for ProposalPassed events */
  startListening() {
    this.governance.on("ProposalPassed", async (proposalId, data, event) => {
      try {
        // ethers v6: the last arg is a ContractEventPayload; .log gives the EventLog
        const eventLog = event.log;
        await this._waitForConfirmation(eventLog);
      } catch (err) {
        this.log(`[Listener] Error handling ProposalPassed event: ${err.message}`);
      }
    });
    this.log("[Listener] Watching Chain B for ProposalPassed events");
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
    const parsed = this.governance.interface.parseLog({
      topics: log.topics,
      data: log.data,
    });

    const proposalId = Number(parsed.args.proposalId);
    const data = parsed.args.data;

    // Confirmation check
    if (currentBlock - log.blockNumber < this.confirmationDepth) {
      this.log(`[Listener] Proposal ${proposalId} not yet confirmed`);
      return;
    }

    // Replay check
    if (this.db.isProcessed(proposalId, "chainB", "ProposalPassed")) {
      this.log(`[Listener] Proposal ${proposalId} already processed, skipping`);
      return;
    }

    // Decode the action from proposal data
    const selector = data.slice(0, 10); // First 4 bytes = function selector
    const pauseSelector = "0x6b9a13e3"; // keccak256("pauseBridge()")[:4]

    this.log(`[Relayer] Processing governance proposal ${proposalId} — selector: ${selector}`);

    if (selector === pauseSelector) {
      await this._executePauseBridge(proposalId, log);
    } else {
      this.log(`[Relayer] Unknown governance action selector: ${selector}`);
    }
  }

  async _executePauseBridge(proposalId, log) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const tx = await this.govEmergency.pauseBridge();
        const receipt = await tx.wait();

        this.db.markProcessed(proposalId, "chainB", receipt.hash, "ProposalPassed");
        this.db.setLastBlock("chainB_governance", log.blockNumber);

        this.log(`[Relayer] Bridge paused via governance — proposal ${proposalId}, tx: ${receipt.hash}`);
        return;
      } catch (err) {
        this.log(`[Relayer] PauseBridge attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        } else {
          this.log(`[Relayer] CRITICAL — Failed to pause bridge for proposal ${proposalId}`);
        }
      }
    }
  }
}

module.exports = GovernanceListener;
