import type { Candidate, FilterVerdict, SecurityReport } from "../types.js";
import type { DeskConfig } from "../config.js";
import { getBestSolanaPair } from "../data/dexscreener.js";
import { getHourlyVolumeUsd } from "../data/geckoterminal.js";
import { getRugCheckReport, isClassicSplToken } from "../data/rugcheck.js";
import { getGoPlusReport } from "../data/goplus.js";
import { getMintInfo, getTop10HolderPct } from "../data/rpc.js";
import { checkKnownRugger, noteRugger } from "../core/ruggerDb.js";
import { limiters } from "../util/rateLimit.js";

/**
 * FILTER — hard security gate. Cheapest-first, fail-fast, reject-on-unverifiable.
 * Verified against live API responses 2026-11 (see AGENTS.md session 2).
 */
export class FilterAgent {
  constructor(private cfg: DeskConfig) {}

  async evaluate(candidate: Candidate): Promise<FilterVerdict> {
    const notes: string[] = [];
    const now = Date.now();

    // ── 1. DexScreener: pair exists, age, liquidity, price ─────────────
    const dex = await getBestSolanaPair(candidate.mint);
    if (dex.kind === "error") return { ok: false, reason: "dexscreener-unverifiable" };
    if (dex.kind === "not-found") return { ok: false, reason: "no-dex-pair" };
    const pair = dex.pair;
    const symbol = candidate.symbol ?? dex.symbol;
    const name = candidate.name ?? dex.name;

    if (pair.priceUsd === null || pair.priceUsd <= 0) return { ok: false, reason: "no-price" };
    if (pair.pairCreatedAt === null) return { ok: false, reason: "age-unverifiable" };
    if (now - pair.pairCreatedAt < this.cfg.pipeline.minTokenAgeMs) return { ok: false, reason: "too-new" };
    if (pair.liquidityUsd === null) return { ok: false, reason: "liquidity-unverifiable" };
    if (pair.liquidityUsd < this.cfg.filter.minLiquidityUsd) return { ok: false, reason: "low-liquidity" };

    // ── 2. GeckoTerminal: hourly volume ≥ $50k summed across top pools ──
    // (volumes split across pools; partial sums are conservative lower bounds,
    //  so a pass guarantees ≥ threshold, a fail on partial data is also safe)
    const hourlyVolumeUsd = await this.sumHourlyVolume(dex.pools);
    if (hourlyVolumeUsd === null) return { ok: false, reason: "hourly-volume-unverifiable" };
    if (hourlyVolumeUsd < this.cfg.filter.minHourlyVolumeUsd)
      return { ok: false, reason: "low-hourly-volume" };

    // ── 3. RugCheck: authorities, LP lock, top-10, rugged, creator ─────
    const rc = await getRugCheckReport(candidate.mint);
    if (!rc) return { ok: false, reason: "rugcheck-unverifiable" };
    if (rc.mintAuthorityRevoked === null) return { ok: false, reason: "mint-authority-unverifiable" };
    if (!rc.mintAuthorityRevoked) return { ok: false, reason: "mint-authority-active" };
    if (rc.freezeAuthorityRevoked === null) return { ok: false, reason: "freeze-authority-unverifiable" };
    if (!rc.freezeAuthorityRevoked) return { ok: false, reason: "freeze-authority-active" };
    if (rc.lpLockedPct === null) return { ok: false, reason: "lp-lock-unverifiable" };
    if (rc.lpLockedPct < this.cfg.filter.lpLockMinPct) return { ok: false, reason: "lp-not-locked" };
    if (rc.top10Pct === null) return { ok: false, reason: "top10-unverifiable" };
    if (rc.top10Pct > this.cfg.filter.maxTop10Pct) return { ok: false, reason: "top10-concentration" };

    // ── 4. GoPlus: authorities + Token-2022 honeypot extensions ────────
    const gp = await getGoPlusReport(candidate.mint);
    if (!gp) return { ok: false, reason: "goplus-unverifiable" };
    if (gp.freezeAuthorityRevoked === false) return { ok: false, reason: "freeze-authority-active-goplus" };

    // Token-2022 extension checks only apply when the mint is actually Token-2022
    // (GoPlus returns misleading extension fields for classic SPL mints).
    if (!isClassicSplToken(rc.tokenProgram)) {
      notes.push(`token-program=${rc.tokenProgram?.slice(0, 8)}`);
      if (gp.transferHook === true) return { ok: false, reason: "token2022-transfer-hook" };
      if (gp.defaultAccountStateFrozen === true) return { ok: false, reason: "token2022-frozen-state" };
      if (gp.balanceMutableAuthority === true) return { ok: false, reason: "token2022-balance-mutable" };
      if (gp.nonTransferable === true) return { ok: false, reason: "token2022-non-transferable" };
      if (gp.transferFeeActive === true) return { ok: false, reason: "token2022-transfer-fee" };
    }

    // ── 5. Dev wallet rug history ──────────────────────────────────────
    const devVerdict = await this.checkDevHistory(candidate, rc);
    if (!devVerdict.ok) return devVerdict;
    notes.push(`dev-priors=${devVerdict.priorTokens ?? "?"}`);

    // ── 6. On-chain RPC double-check: mint/freeze authority + top-10 ────
    await limiters.rpc.wait();
    const onchain = await getMintInfo(this.cfg.rpc.url, candidate.mint);
    if (!onchain) return { ok: false, reason: "rpc-mint-unverifiable" };
    if (onchain.mintAuthority !== null) return { ok: false, reason: "mint-authority-active-onchain" };
    if (onchain.freezeAuthority !== null) return { ok: false, reason: "freeze-authority-active-onchain" };

    // Holder double-check: enforce RPC top10 when available. On free-RPC throttle
    // fall back to RugCheck's top10 (already enforced at step 3 — verified data),
    // with a note. The CONDITION remains verified either way.
    const holders = await getTop10HolderPct(this.cfg.rpc.url, candidate.mint, onchain.supplyRaw);
    let finalTop10 = rc.top10Pct;
    if (holders.top10Pct !== null) {
      if (holders.top10Pct > this.cfg.filter.maxTop10Pct)
        return { ok: false, reason: "top10-concentration-onchain" };
      finalTop10 = holders.top10Pct;
      notes.push(`onchain-top10=${(holders.top10Pct * 100).toFixed(1)}%`);
    } else {
      notes.push("top10-rpc-unavailable-fallback-rugcheck");
    }

    const report: SecurityReport = {
      mint: candidate.mint,
      symbol,
      name,
      dev: devVerdict.dev,
      priceUsd: pair.priceUsd,
      liquidityUsd: pair.liquidityUsd,
      volumeH24Usd: pair.volumeH24Usd,
      hourlyVolumeUsd,
      buyCountH1: pair.buysH1,
      sellCountH1: pair.sellsH1,
      pairCreatedAt: pair.pairCreatedAt,
      pool: pair.pairAddress,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpLockedPct: rc.lpLockedPct,
      top10Pct: finalTop10,
      devRugCheck: "clean",
      devPriorTokens: devVerdict.priorTokens,
      notes,
    };
    return { ok: true, report };
  }

  /** Sum hourly USD volume across up to 2 pools; early-breaks once threshold is met. */
  private async sumHourlyVolume(pools: string[]): Promise<number | null> {
    let total = 0;
    let any = false;
    for (const pool of pools.slice(0, 2)) {
      const v = await getHourlyVolumeUsd(pool);
      if (v !== null) {
        any = true;
        total += v;
        if (total >= this.cfg.filter.minHourlyVolumeUsd) return total;
      }
    }
    return any ? total : null;
  }

  /**
   * Dev rug history — free-tier best effort:
   *   1. local rugger DB
   *   2. current token rugged flag (dev rugged this token)
   *   3. RugCheck creatorTokens: sample N oldest priors, check each `rugged` flag
   *   4. policy: "reject-on-unknown" (default) when evidence incomplete
   */
  private async checkDevHistory(
    candidate: Candidate,
    rc: Awaited<ReturnType<typeof getRugCheckReport>>
  ): Promise<{ ok: true; dev: string; priorTokens: number | null } | { ok: false; reason: string }> {
    if (!rc) return { ok: false, reason: "rugcheck-unverifiable" };
    const dev = candidate.dev ?? rc.creator;
    if (!dev || dev.length < 32) return { ok: false, reason: "dev-unverifiable" };

    if (checkKnownRugger(dev)) return { ok: false, reason: "dev-known-rugger-local-db" };

    if (rc.rugged === true) {
      noteRugger(dev, 1, "rugcheck-rugged-current-token");
      return { ok: false, reason: "token-flagged-rugged" };
    }

    if (rc.creatorTokens === null) {
      // No enumerable prior-token list → dev history cannot be verified
      if (this.cfg.filter.devHistoryPolicy === "reject-on-unknown") {
        return { ok: false, reason: "dev-history-unverifiable" };
      }
      return { ok: true, dev, priorTokens: null };
    }

    if (rc.creatorTokens.length === 0) {
      return { ok: true, dev, priorTokens: 0 }; // verified: zero prior tokens
    }

    // Sample N oldest priors (most likely completed/rugged launches)
    const priors = rc.creatorTokens
      .filter((t) => t.mint !== candidate.mint)
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
      .slice(0, this.cfg.filter.devRugSampleSize);

    for (const prior of priors) {
      const report = await getRugCheckReport(prior.mint);
      if (!report) {
        if (this.cfg.filter.devHistoryPolicy === "reject-on-unknown") {
          return { ok: false, reason: "dev-prior-token-unverifiable" };
        }
        continue;
      }
      if (report.rugged === true) {
        noteRugger(dev, 1, "rugcheck-prior-token-rugged");
        return { ok: false, reason: "dev-prior-rugs" };
      }
    }

    return { ok: true, dev, priorTokens: rc.creatorTokens.length };
  }
}
