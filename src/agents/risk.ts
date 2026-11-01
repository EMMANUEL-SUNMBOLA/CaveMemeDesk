import type { DeskConfig } from "../config.js";
import type { Portfolio } from "../core/portfolio.js";
import { getBestSolanaPair } from "../data/dexscreener.js";
import { getSolUsd } from "../data/dexscreener.js";
import { LOGGER } from "./logger.js";

/**
 * RISK — owns open positions until exit. Enforces, on every tick:
 *  - hard stop-loss from entry
 *  - trailing stop (-3% from peak) ONLY after +12% activation
 *  - max-hold timeout
 *  - daily kill switch (blocks new entries at -5% day PnL)
 *  - anti-revenge cooldown (N consecutive losses)
 * Never averages down (structural) / never revenge-trades (cooldown).
 */
export class RiskAgent {
  private timer: NodeJS.Timeout | null = null;
  private solTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  solUsd: number;

  constructor(
    private cfg: DeskConfig,
    private portfolio: Portfolio,
    initialSolUsd: number
  ) {
    this.solUsd = initialSolUsd;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.risk.tickMs);
    this.solTimer = setInterval(() => void this.refreshSolPrice(), 300_000);
    LOGGER.event("RISK", "info", `risk loop active: SL -${(this.cfg.risk.hardStopLossPct * 100).toFixed(0)}%, trail after +${(this.cfg.risk.trailActivationPct * 100).toFixed(0)}% @ -${(this.cfg.risk.trailDistancePct * 100).toFixed(0)}%, timeout ${this.cfg.risk.timeoutExitHours}h`);
  }

  private async refreshSolPrice(): Promise<void> {
    const p = await getSolUsd();
    if (p && p > 0) this.solUsd = p;
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.stopped) return;

    // Daily kill switch — block new entries, keep managing open risk
    const day = this.portfolio.dayPnl();
    if (!this.portfolio.killSwitchActive && day.pct <= -this.cfg.risk.dailyKillSwitchPct) {
      this.portfolio.killSwitchActive = true;
      const nextUtcMidnight = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate() + 1
      );
      this.portfolio.killSwitchUntil = nextUtcMidnight;
      LOGGER.event("RISK", "error", `DAILY KILL SWITCH: day PnL ${(day.pct * 100).toFixed(2)}% — entries halted until UTC midnight`);
      LOGGER.decision("RISK", "halted", null, "daily-kill-switch", { dayPnlPct: day.pct });
    }

    // Anti-revenge cooldown trigger
    if (
      this.portfolio.cooldownUntil === null &&
      this.portfolio.consecutiveLosses >= this.cfg.risk.consecutiveLossesToCooldown
    ) {
      this.portfolio.cooldownUntil = now + this.cfg.risk.cooldownMinutes * 60_000;
      LOGGER.event("RISK", "warn", `${this.portfolio.consecutiveLosses} consecutive losses — entry cooldown ${this.cfg.risk.cooldownMinutes}min (anti-revenge)`);
      LOGGER.decision("RISK", "halted", null, "anti-revenge-cooldown", {
        losses: this.portfolio.consecutiveLosses,
      });
    }

    if (this.portfolio.positions.size === 0) return;

    // Batch price refresh for open positions
    const mints = [...this.portfolio.positions.keys()];
    for (const mint of mints) {
      const dex = await getBestSolanaPair(mint);
      if (dex.kind !== "ok" || dex.pair.priceUsd === null || dex.pair.priceUsd <= 0) {
        LOGGER.event("RISK", "warn", `no mark for ${mint.slice(0, 8)}… — position unmanaged this tick (stop floor stays)`);
        continue;
      }
      const price = dex.pair.priceUsd;
      this.portfolio.updateMark(mint, price);
      const pos = this.portfolio.positions.get(mint);
      if (!pos) continue;

      // Timeout exit — highest priority (age beats hope)
      if (now - pos.entryTs >= this.cfg.risk.timeoutExitHours * 3600_000) {
        this.close(mint, price, "timeout");
        continue;
      }

      // Hard stop-loss from effective entry
      if (price <= pos.stopPriceUsd && !pos.trailingActive) {
        this.close(mint, price, "hard-stop");
        continue;
      }

      // Peak tracking
      if (price > pos.peakPriceUsd) pos.peakPriceUsd = price;

      // Trailing activation after +12%
      const unrealizedPct = (price - pos.entryPriceUsd) / pos.entryPriceUsd;
      if (!pos.trailingActive && unrealizedPct >= this.cfg.risk.trailActivationPct) {
        pos.trailingActive = true;
        LOGGER.event("RISK", "info", `${pos.symbol ?? mint.slice(0, 8)}… +${(unrealizedPct * 100).toFixed(1)}% — trailing stop armed at -${(this.cfg.risk.trailDistancePct * 100).toFixed(0)}% from peak`);
        LOGGER.decision("RISK", "system", mint, "trailing-armed", { peak: pos.peakPriceUsd });
      }

      if (pos.trailingActive) {
        const trailStop = pos.peakPriceUsd * (1 - this.cfg.risk.trailDistancePct);
        if (trailStop > pos.stopPriceUsd) pos.stopPriceUsd = trailStop;
        if (price <= pos.stopPriceUsd) {
          this.close(mint, price, "trailing-stop");
        }
      }
    }
  }

  private close(mint: string, price: number, reason: string): void {
    const trade = this.portfolio.closePosition(mint, price, reason);
    if (!trade) return;
    const sign = trade.pnlUsd >= 0 ? "+" : "";
    LOGGER.trade(
      "trade-closed",
      mint,
      `CLOSED ${trade.symbol ?? mint.slice(0, 8)} ${reason} ${sign}$${trade.pnlUsd.toFixed(2)} (${sign}${(trade.pnlPct * 100).toFixed(2)}%) hold ${Math.round(trade.holdSeconds / 60)}m`,
      { reason, pnlUsd: trade.pnlUsd, pnlPct: trade.pnlPct, holdSeconds: trade.holdSeconds }
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.solTimer) clearInterval(this.solTimer);
    this.timer = null;
    this.solTimer = null;
  }
}
