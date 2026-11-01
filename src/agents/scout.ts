import { Connection, PublicKey } from "@solana/web3.js";
import type { Candidate } from "../types.js";
import { PumpPortalClient } from "../data/pumpportal.js";
import { LOGGER } from "./logger.js";

export interface ScoutOptions {
  raydiumEnabled: boolean;
  raydiumAmmV4Program: string;
  raydiumBackoffMs: number;
  rpcUrl: string;
}

export type CandidateHandler = (c: Candidate) => void;

export class Scout {
  private pump = new PumpPortalClient();
  private conn: Connection | null = null;
  private unsub: number | null = null;
  private raydiumBackoffUntil = 0;
  private seenSig = new Set<string>();
  private stopped = false;

  constructor(private opts: ScoutOptions, private onCandidate: CandidateHandler) {}

  start(): void {
    this.pump.on("candidate", (c: Candidate) => {
      LOGGER.event("SCOUT", "info", `candidate ${c.symbol ?? c.mint.slice(0, 8)} source=${c.source}`);
      LOGGER.decision("SCOUT", "scouted", c.mint, c.source, { name: c.name, symbol: c.symbol, dev: c.dev });
      this.onCandidate(c);
    });
    this.pump.start();

    if (this.opts.raydiumEnabled) this.startRaydium();
  }

  private startRaydium(): void {
    try {
      this.conn = new Connection(this.opts.rpcUrl, { commitment: "processed" });
      const program = new PublicKey(this.opts.raydiumAmmV4Program);
      this.unsub = this.conn.onLogs(
        program,
        (logs) => {
          if (this.stopped) return;
          if (!logs.logs.some((l) => l.includes("initialize2") || l.includes("InitializeInstruction2"))) return;
          void this.handleRaydiumInit(logs.signature);
        },
        "processed"
      );
      LOGGER.event("SCOUT", "info", `Raydium AMM v4 logs subscription active (${this.opts.raydiumAmmV4Program.slice(0, 8)}…)`);
    } catch (err) {
      LOGGER.event("SCOUT", "warn", `Raydium listener unavailable: ${err instanceof Error ? err.message : err}`);
      this.opts.raydiumEnabled = false;
    }
  }

  private async handleRaydiumInit(sig: string): Promise<void> {
    if (this.seenSig.has(sig) || Date.now() < this.raydiumBackoffUntil) return;
    this.seenSig.add(sig);
    if (this.seenSig.size > 2000) {
      const first = this.seenSig.values().next().value;
      if (first) this.seenSig.delete(first);
    }
    if (!this.conn) return;
    try {
      const tx = await this.conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      const msg = tx?.transaction?.message;
      if (!msg) return;
      if (!("accountKeys" in msg) || !("instructions" in msg)) return; // v0 message — skip for now
      const keys = (msg.accountKeys as Array<string | { toBase58(): string }>).map((k) =>
        typeof k === "string" ? k : k.toBase58()
      );
      for (const ix of msg.instructions as Array<{
        programIdIndex?: number;
        accounts?: number[];
      }>) {
        const programId = ix.programIdIndex !== undefined ? (keys[ix.programIdIndex] ?? "") : "";
        if (programId !== this.opts.raydiumAmmV4Program) continue;
        const accs = (ix as { accounts?: number[] }).accounts;
        if (!accs || accs.length < 10) continue;
        const mintA = keys[accs[8]];
        const mintB = keys[accs[9]];
        if (!mintA || !mintB) continue;
        // Prefer the non-SOL mint as the candidate (both emitted — filter dedups)
        for (const mint of [mintA, mintB]) {
          if (mint === "So11111111111111111111111111111111111111112") continue;
          this.onCandidate({
            mint,
            source: "raydium-init",
            ts: Date.now(),
            pool: keys[accs[1]] ?? undefined,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|rate|too many/i.test(msg)) {
        this.raydiumBackoffUntil = Date.now() + this.opts.raydiumBackoffMs;
        LOGGER.event("SCOUT", "warn", `Raydium RPC rate-limited — backing off ${Math.round(this.opts.raydiumBackoffMs / 1000)}s`);
      } else {
        LOGGER.event("SCOUT", "warn", `Raydium tx parse failed: ${msg.slice(0, 120)}`);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.pump.stop();
    try {
      if (this.unsub && this.conn) void this.conn.removeOnLogsListener(this.unsub);
    } catch {
      /* ignore */
    }
    this.unsub = null;
  }
}
