import type { Candidate } from "./types.js";
import type { DeskConfig } from "./config.js";
import { Scout } from "./agents/scout.js";
import { FilterAgent } from "./agents/filter.js";
import { AnalystAgent } from "./agents/analyst.js";
import { ExecutorAgent } from "./agents/executor.js";
import { RiskAgent } from "./agents/risk.js";
import { LOGGER } from "./agents/logger.js";

/** Timing-dependent rejects are reschedulable (data not ready yet).
 *  Safety rejects (authorities, LP, holders, dev, honeypot) are always terminal. */
const SOFT_REJECTS = new Set([
  "too-new",
  "no-dex-pair",
  "age-unverifiable",
  "liquidity-unverifiable",
  "dexscreener-unverifiable",
  "hourly-volume-unverifiable",
  "rugcheck-unverifiable",
  "top10-unverifiable",
]);
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000]; // max 3 retries

/**
 * Hard-handoff pipeline: SCOUT → FILTER → ANALYST → EXECUTOR → RISK.
 * One-directional; safety rejections at any stage are terminal and logged.
 * Timing rejections get bounded reschedules (data maturity), then go terminal.
 * Bounded queue + mint dedup + concurrency throttle (free-tier friendly).
 */
export class Pipeline {
  private queue: Candidate[] = [];
  private inflight = 0;
  private dedup = new Map<string, number>();
  private retryCount = new Map<string, number>();
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private scout: Scout;
  readonly filter: FilterAgent;
  readonly analyst: AnalystAgent;
  readonly executor: ExecutorAgent;
  readonly risk: RiskAgent;

  stats = { seen: 0, rejected: 0, passedFilter: 0, scored: 0, traded: 0, dropped: 0, rescheduled: 0 };

  constructor(
    private cfg: DeskConfig,
    executor: ExecutorAgent,
    risk: RiskAgent
  ) {
    this.executor = executor;
    this.risk = risk;
    this.filter = new FilterAgent(cfg);
    this.analyst = new AnalystAgent(cfg);
    this.scout = new Scout(
      {
        raydiumEnabled: cfg.scout.raydiumEnabled,
        raydiumAmmV4Program: cfg.scout.raydiumAmmV4Program,
        raydiumBackoffMs: cfg.scout.raydiumBackoffMs,
        rpcUrl: cfg.rpc.url,
      },
      (c) => this.enqueue(c)
    );
  }

  start(): void {
    this.scout.start();
    LOGGER.event("LOGGER", "info", `pipeline online — mode=${this.cfg.mode} queue<${this.cfg.pipeline.queueMax} concurrency=${this.cfg.pipeline.concurrency}`);
  }

  enqueue(candidate: Candidate): void {
    if (this.stopped) return;
    this.stats.seen++;

    // Dedup by mint — but source matters: a create event and a later migration/raydium
    // event are different lifecycle stages; migration must not be dropped after create.
    const key = `${candidate.source}:${candidate.mint}`;
    const last = this.dedup.get(key);
    if (last !== undefined && Date.now() - last < this.cfg.pipeline.dedupeTtlMs) return;
    this.dedup.set(key, Date.now());
    if (this.dedup.size > 5000) {
      const cutoff = Date.now() - this.cfg.pipeline.dedupeTtlMs;
      for (const [k, v] of this.dedup) if (v < cutoff) this.dedup.delete(k);
    }

    if (this.queue.length >= this.cfg.pipeline.queueMax) {
      this.stats.dropped++;
      LOGGER.event("SCOUT", "warn", `queue full — dropped ${candidate.mint.slice(0, 8)}…`);
      return;
    }
    this.queue.push(candidate);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.inflight < this.cfg.pipeline.concurrency && this.queue.length > 0) {
      const candidate = this.queue.shift()!;
      this.inflight++;
      void this.runChain(candidate).finally(() => {
        this.inflight--;
        this.pump();
      });
    }
  }

  /** One candidate's forward-only journey. Any throw = reject. */
  private async runChain(candidate: Candidate): Promise<void> {
    try {
      // ── FILTER ───────────────────────────────────────────────
      const verdict = await this.filter.evaluate(candidate);
      if (!verdict.ok) {
        this.stats.rejected++;
        LOGGER.reject("FILTER", candidate.mint, verdict.reason, {
          source: candidate.source,
          symbol: candidate.symbol,
        });
        this.maybeReschedule(candidate, verdict.reason);
        return;
      }
      this.stats.passedFilter++;
      LOGGER.pass("FILTER", candidate.mint, `passed all security checks (vol $${Math.round(verdict.report.hourlyVolumeUsd)}/h, liq $${Math.round(verdict.report.liquidityUsd)}, lpLocked ${(verdict.report.lpLockedPct * 100).toFixed(0)}%)`, {
        symbol: verdict.report.symbol,
      });

      // ── ANALYST ──────────────────────────────────────────────
      const score = this.analyst.score(verdict.report);
      this.stats.scored++;
      if (!this.analyst.shouldTrade(score)) {
        this.stats.rejected++;
        LOGGER.reject("ANALYST", candidate.mint, `score ${score.score.toFixed(3)} < ${this.cfg.analyst.minScore}`, score.breakdown);
        return;
      }
      LOGGER.decision("ANALYST", "scored", candidate.mint, `score ${score.score.toFixed(3)} >= ${this.cfg.analyst.minScore} — trade signal`, score.breakdown);
      LOGGER.event("ANALYST", "pass", `${(verdict.report.symbol ?? candidate.mint.slice(0, 8))}… scored ${score.score.toFixed(2)} — forwarding to EXECUTOR`);

      // ── EXECUTOR (hard handoff) ──────────────────────────────
      const opened = this.executor.tryOpen(verdict.report, score);
      if (opened) this.stats.traded++;
      // RISK takes over ownership of the position inside Portfolio
    } catch (err) {
      this.stats.rejected++;
      const msg = err instanceof Error ? err.message : String(err);
      LOGGER.reject("FILTER", candidate.mint, `pipeline-error: ${msg.slice(0, 160)}`);
    }
  }

  /** Bounded reschedule for soft (timing) rejects — max 3 attempts, then terminal. */
  private maybeReschedule(candidate: Candidate, reason: string): void {
    if (this.stopped || !SOFT_REJECTS.has(reason)) return;
    const attempt = this.retryCount.get(candidate.mint) ?? 0;
    if (attempt >= RETRY_DELAYS_MS.length) {
      LOGGER.decision("FILTER", "rejected", candidate.mint, `${reason}-retries-exhausted`, {
        attempts: attempt,
      });
      return;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    this.retryCount.set(candidate.mint, attempt + 1);
    this.stats.rescheduled++;
    LOGGER.decision("FILTER", "system", candidate.mint, "soft-reject-rescheduled", {
      reason,
      attempt: attempt + 1,
      retryInMin: Math.round(delay / 60_000),
    });
    const timer = setTimeout(() => {
      this.retryTimers.delete(candidate.mint);
      if (this.stopped) return;
      // allow re-entry past dedup for this exact retry
      this.dedup.delete(`${candidate.source}:${candidate.mint}`);
      this.enqueue(candidate);
    }, delay);
    this.retryTimers.set(candidate.mint, timer);
  }

  stop(): void {
    this.stopped = true;
    this.scout.stop();
    this.queue.length = 0;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }
}
