import type { ClosedTrade, Candidate, EquitySnapshot, Position } from "../types.js";
import { insertEquitySnapshot, insertTrade } from "../util/db.js";

export interface PortfolioParams {
  startingBalanceUsd: number;
  feePct: number;
  slippageMinPct: number;
  slippageMaxPct: number;
  maxPositionPct: number;
  hardStopLossPct: number;
}

export class Portfolio {
  cashUsd: number;
  readonly startingBalanceUsd: number;
  readonly params: PortfolioParams;
  positions = new Map<string, Position>();
  marks = new Map<string, number>();
  recentTrades: ClosedTrade[] = [];
  equityCurve: EquitySnapshot[] = [];
  consecutiveLosses = 0;
  cooldownUntil: number | null = null;
  killSwitchActive = false;
  killSwitchUntil: number | null = null;
  private dayKey: string;
  private dayStartEquity: number;

  constructor(params: PortfolioParams) {
    this.params = params;
    this.cashUsd = params.startingBalanceUsd;
    this.startingBalanceUsd = params.startingBalanceUsd;
    this.dayKey = utcDayKey();
    this.dayStartEquity = params.startingBalanceUsd;
  }

  /** Effective slippage estimate by liquidity depth (deeper → tighter). */
  slippagePct(liquidityUsd: number): number {
    const { slippageMinPct: lo, slippageMaxPct: hi } = this.params;
    if (liquidityUsd >= 250_000) return lo;
    if (liquidityUsd <= 10_000) return hi;
    const t = (liquidityUsd - 10_000) / 240_000;
    return hi - t * (hi - lo);
  }

  positionValueUsd(mint: string): number {
    const pos = this.positions.get(mint);
    const mark = this.marks.get(mint);
    if (!pos) return 0;
    return pos.tokens * (mark ?? pos.entryPriceUsd);
  }

  equityUsd(): number {
    let v = this.cashUsd;
    for (const mint of this.positions.keys()) v += this.positionValueUsd(mint);
    return v;
  }

  openPnlUsd(): number {
    let pnl = 0;
    for (const [mint, pos] of this.positions) {
      const mark = this.marks.get(mint) ?? pos.entryPriceUsd;
      pnl += pos.tokens * mark - pos.costUsd;
    }
    return pnl;
  }

  dayPnl(): { usd: number; pct: number } {
    const key = utcDayKey();
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayStartEquity = this.equityUsd();
    }
    const usd = this.equityUsd() - this.dayStartEquity;
    const pct = this.dayStartEquity > 0 ? usd / this.dayStartEquity : 0;
    return { usd, pct };
  }

  canOpen(): { ok: true } | { ok: false; reason: string } {
    if (this.killSwitchActive) {
      if (this.killSwitchUntil !== null && Date.now() >= this.killSwitchUntil) {
        this.killSwitchActive = false;
        this.killSwitchUntil = null;
      } else {
        return { ok: false, reason: "kill-switch-active" };
      }
    }
    if (this.cooldownUntil !== null) {
      if (Date.now() < this.cooldownUntil) return { ok: false, reason: "loss-cooldown" };
      this.cooldownUntil = null;
    }
    return { ok: true };
  }

  /**
   * Paper open. Hard invariant: sizeUsd <= cash * maxPositionPct (double-checked here
   * even though the Executor sizes first). One position per mint — no averaging down.
   */
  openPosition(
    candidate: Pick<Candidate, "mint" | "symbol">,
    markPriceUsd: number,
    liquidityUsd: number,
    openReason: string
  ): { ok: true; position: Position; sizeUsd: number } | { ok: false; reason: string } {
    if (this.positions.has(candidate.mint)) return { ok: false, reason: "position-already-open" };
    if (markPriceUsd <= 0) return { ok: false, reason: "invalid-price" };

    const gate = this.canOpen();
    if (!gate.ok) return gate;

    let sizeUsd = this.cashUsd * this.params.maxPositionPct;
    // HARD CAP — never exceed max position size of current balance
    const cap = this.cashUsd * this.params.maxPositionPct;
    if (sizeUsd > cap) sizeUsd = cap;
    if (sizeUsd < 1) return { ok: false, reason: "insufficient-cash" };

    const slip = this.slippagePct(liquidityUsd);
    const tokens = (sizeUsd * (1 - this.params.feePct)) / (markPriceUsd * (1 + slip));
    const effectiveEntry = sizeUsd / tokens;

    const pos: Position = {
      mint: candidate.mint,
      symbol: candidate.symbol,
      tokens,
      costUsd: sizeUsd,
      entryPriceUsd: effectiveEntry,
      entryTs: Date.now(),
      peakPriceUsd: effectiveEntry,
      trailingActive: false,
      stopPriceUsd: effectiveEntry * (1 - this.params.hardStopLossPct),
      openReason,
    };
    this.cashUsd -= sizeUsd;
    this.positions.set(pos.mint, pos);
    this.marks.set(pos.mint, effectiveEntry);
    return { ok: true, position: pos, sizeUsd };
  }

  updateMark(mint: string, priceUsd: number): void {
    if (!this.positions.has(mint) || priceUsd <= 0) return;
    this.marks.set(mint, priceUsd);
  }

  closePosition(mint: string, exitPriceUsd: number, closeReason: string): ClosedTrade | null {
    const pos = this.positions.get(mint);
    if (!pos) return null;
    if (exitPriceUsd <= 0) return null;

    const slip = this.slippagePct(this.marks.get(mint) ?? 0);
    const proceedsUsd = pos.tokens * exitPriceUsd * (1 - this.params.feePct) * (1 - slip);
    const pnlUsd = proceedsUsd - pos.costUsd;
    const pnlPct = pos.costUsd > 0 ? pnlUsd / pos.costUsd : 0;

    this.cashUsd += proceedsUsd;
    this.positions.delete(mint);
    this.marks.delete(mint);

    if (pnlUsd < 0) {
      this.consecutiveLosses += 1;
    } else {
      this.consecutiveLosses = 0;
    }

    const trade: ClosedTrade = {
      mint,
      symbol: pos.symbol,
      openedTs: pos.entryTs,
      closedTs: Date.now(),
      costUsd: pos.costUsd,
      proceedsUsd,
      pnlUsd,
      pnlPct,
      entryPriceUsd: pos.entryPriceUsd,
      exitPriceUsd,
      holdSeconds: Math.round((Date.now() - pos.entryTs) / 1000),
      openReason: pos.openReason,
      closeReason,
    };
    this.recentTrades.push(trade);
    if (this.recentTrades.length > 50) this.recentTrades.shift();
    try {
      insertTrade(trade);
    } catch {
      /* db not ready */
    }
    return trade;
  }

  snapshot(): EquitySnapshot {
    const snap: EquitySnapshot = {
      ts: Date.now(),
      cashUsd: this.cashUsd,
      equityUsd: this.equityUsd(),
      openPositions: this.positions.size,
    };
    this.equityCurve.push(snap);
    if (this.equityCurve.length > 1500) this.equityCurve.shift();
    try {
      insertEquitySnapshot(snap);
    } catch {
      /* db not ready */
    }
    return snap;
  }
}

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
