import type { ScoreResult, SecurityReport } from "../types.js";
import type { DeskConfig } from "../config.js";
import type { Portfolio } from "../core/portfolio.js";
import { LOGGER } from "./logger.js";

/** EXECUTOR — paper fills only in v0.1. Enforces the 8% hard cap (double-checked here). */
export class ExecutorAgent {
  constructor(
    private cfg: DeskConfig,
    private portfolio: Portfolio
  ) {}

  tryOpen(report: SecurityReport, score: ScoreResult): boolean {
    const gate = this.portfolio.canOpen();
    if (!gate.ok) {
      LOGGER.event("EXECUTOR", "warn", `entry blocked: ${gate.reason}`);
      LOGGER.decision("EXECUTOR", "halted", report.mint, gate.reason);
      return false;
    }

    const reason = JSON.stringify({
      score: Number(score.score.toFixed(3)),
      topFactor: Object.entries(score.breakdown).sort((a, b) => b[1] - a[1])[0]?.[0],
      hourlyVolUsd: Math.round(report.hourlyVolumeUsd),
      liqUsd: Math.round(report.liquidityUsd),
      top10: Number((report.top10Pct * 100).toFixed(1)),
      lpLockedPct: Number((report.lpLockedPct * 100).toFixed(1)),
      dev: report.dev,
      mode: this.cfg.mode,
    });

    const res = this.portfolio.openPosition(
      { mint: report.mint, symbol: report.symbol },
      report.priceUsd,
      report.liquidityUsd,
      reason
    );
    if (!res.ok) {
      LOGGER.event("EXECUTOR", "warn", `open failed: ${res.reason}`);
      LOGGER.decision("EXECUTOR", "halted", report.mint, res.reason);
      return false;
    }

    // HARD CAP double-check: position must never exceed maxPositionPct of balance-at-fill
    const balanceAtFill = this.portfolio.cashUsd + res.sizeUsd;
    const maxAllowed = balanceAtFill * this.cfg.executor.maxPositionPct;
    if (res.position.costUsd > maxAllowed + 1e-9) {
      // Should be unreachable — if it ever triggers, abort the position immediately
      this.portfolio.closePosition(report.mint, report.priceUsd, "hard-cap-violation-abort");
      LOGGER.event("EXECUTOR", "error", `HARD CAP VIOLATION averted on ${report.mint}`);
      LOGGER.decision("EXECUTOR", "halted", report.mint, "hard-cap-violation-abort");
      return false;
    }

    LOGGER.trade(
      "trade-opened",
      report.mint,
      `OPENED ${report.symbol ?? report.mint.slice(0, 8)} $${res.sizeUsd.toFixed(2)} @ $${res.position.entryPriceUsd.toPrecision(6)} (score ${score.score.toFixed(2)})`,
      { sizeUsd: res.sizeUsd, entry: res.position.entryPriceUsd, reason }
    );
    return true;
  }
}
