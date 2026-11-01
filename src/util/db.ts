import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ClosedTrade, DecisionRecord, EquitySnapshot, FeedEvent } from "../types.js";

let db: DatabaseSync | null = null;
let dbPath = "data/desk.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  mint TEXT,
  reason TEXT NOT NULL,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  symbol TEXT,
  opened_ts INTEGER NOT NULL,
  closed_ts INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  proceeds_usd REAL NOT NULL,
  pnl_usd REAL NOT NULL,
  pnl_pct REAL NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  hold_seconds INTEGER NOT NULL,
  open_reason TEXT NOT NULL,
  close_reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equity_snapshots (
  ts INTEGER NOT NULL,
  cash_usd REAL NOT NULL,
  equity_usd REAL NOT NULL,
  open_positions INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rugger_wallets (
  wallet TEXT PRIMARY KEY,
  rugged_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  seen_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_mint ON decisions(mint);
CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_ts);
`;

export function openDb(path = "data/desk.db"): DatabaseSync {
  if (db) return db;
  dbPath = resolve(path);
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) return openDb();
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function insertEvent(e: Omit<FeedEvent, "id">): void {
  getDb()
    .prepare("INSERT INTO agent_events (ts, agent, level, message) VALUES (?, ?, ?, ?)")
    .run(e.ts, e.agent, e.level, e.message);
}

export function insertDecision(d: DecisionRecord): void {
  getDb()
    .prepare(
      "INSERT INTO decisions (ts, agent, action, mint, reason, metadata) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(d.ts, d.agent, d.action, d.mint, d.reason, d.metadata === undefined ? null : JSON.stringify(d.metadata));
}

export function insertTrade(t: ClosedTrade): void {
  getDb()
    .prepare(
      `INSERT INTO trades
       (mint, symbol, opened_ts, closed_ts, cost_usd, proceeds_usd, pnl_usd, pnl_pct,
        entry_price, exit_price, hold_seconds, open_reason, close_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.mint,
      t.symbol ?? null,
      t.openedTs,
      t.closedTs,
      t.costUsd,
      t.proceedsUsd,
      t.pnlUsd,
      t.pnlPct,
      t.entryPriceUsd,
      t.exitPriceUsd,
      t.holdSeconds,
      t.openReason,
      t.closeReason
    );
}

export function insertEquitySnapshot(s: EquitySnapshot): void {
  getDb()
    .prepare("INSERT INTO equity_snapshots (ts, cash_usd, equity_usd, open_positions) VALUES (?, ?, ?, ?)")
    .run(s.ts, s.cashUsd, s.equityUsd, s.openPositions);
}

export function upsertRugger(wallet: string, ruggedCount: number, source: string): void {
  getDb()
    .prepare(
      `INSERT INTO rugger_wallets (wallet, rugged_count, source, seen_ts)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(wallet) DO UPDATE SET rugged_count = MAX(rugged_count, excluded.rugged_count), seen_ts = excluded.seen_ts`
    )
    .run(wallet, ruggedCount, source, Date.now());
}

export function isKnownRugger(wallet: string): boolean {
  const row = getDb().prepare("SELECT rugged_count FROM rugger_wallets WHERE wallet = ?").get(wallet) as
    | { rugged_count: number }
    | undefined;
  return !!row && row.rugged_count > 0;
}
