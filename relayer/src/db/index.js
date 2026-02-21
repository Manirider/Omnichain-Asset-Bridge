const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

class RelayerDB {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL"); // Write-ahead logging for crash safety
    this._initTables();
  }

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_events (
        nonce     INTEGER NOT NULL,
        chain     TEXT    NOT NULL,
        tx_hash   TEXT    NOT NULL,
        event_type TEXT   NOT NULL,
        created_at TEXT   DEFAULT (datetime('now')),
        PRIMARY KEY (nonce, chain, event_type)
      );

      CREATE TABLE IF NOT EXISTS block_cursors (
        chain      TEXT PRIMARY KEY,
        last_block INTEGER NOT NULL
      );
    `);
  }

  /** Check if an event has already been processed */
  isProcessed(nonce, chain, eventType) {
    const row = this.db.prepare(
      "SELECT 1 FROM processed_events WHERE nonce = ? AND chain = ? AND event_type = ?"
    ).get(nonce, chain, eventType);
    return !!row;
  }

  /** Mark an event as processed */
  markProcessed(nonce, chain, txHash, eventType) {
    this.db.prepare(
      "INSERT OR IGNORE INTO processed_events (nonce, chain, tx_hash, event_type) VALUES (?, ?, ?, ?)"
    ).run(nonce, chain, txHash, eventType);
  }

  /** Get last processed block for a chain */
  getLastBlock(chain) {
    const row = this.db.prepare(
      "SELECT last_block FROM block_cursors WHERE chain = ?"
    ).get(chain);
    return row ? row.last_block : 0;
  }

  /** Update block cursor for a chain */
  setLastBlock(chain, blockNumber) {
    this.db.prepare(
      "INSERT OR REPLACE INTO block_cursors (chain, last_block) VALUES (?, ?)"
    ).run(chain, blockNumber);
  }

  close() {
    this.db.close();
  }
}

module.exports = RelayerDB;
