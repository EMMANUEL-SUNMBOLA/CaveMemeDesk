/**
 * Ad-hoc validator: run the FILTER chain against known live tokens to verify
 * data-layer parsing (RugCheck/GoPlus/GeckoTerminal shapes) on real responses.
 * Usage: npx tsx scripts/checkToken.ts <mint> [mint...]
 */
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/util/db.js";
import { configureFeed } from "../src/util/feed.js";
import { configureLimiters } from "../src/util/rateLimit.js";
import { FilterAgent } from "../src/agents/filter.js";
import type { Candidate } from "../src/types.js";

async function main(): Promise<void> {
  const mints = process.argv.slice(2);
  if (mints.length === 0) {
    console.error("usage: npx tsx scripts/checkToken.ts <mint> [mint...]");
    process.exit(1);
  }
  const cfg = loadConfig();
  openDb("data/desk.db");
  configureFeed({ ringSize: 50, echo: false });
  configureLimiters(cfg.rateLimits);
  const filter = new FilterAgent(cfg);

  for (const mint of mints) {
    const candidate: Candidate = { mint, source: "raydium-init", ts: Date.now() };
    const t0 = Date.now();
    const verdict = await filter.evaluate(candidate);
    const ms = Date.now() - t0;
    if (verdict.ok) {
      console.log(`\n${mint}\n  PASS (${ms}ms)`);
      const { ...r } = verdict.report;
      console.log(
        `  price=$${r.priceUsd.toPrecision(4)} liq=$${Math.round(r.liquidityUsd)} vol1h=$${Math.round(
          r.hourlyVolumeUsd
        )} vol24h=$${r.volumeH24Usd !== null ? Math.round(r.volumeH24Usd) : "?"} top10=${(
          r.top10Pct * 100
        ).toFixed(1)}% lpLocked=${(r.lpLockedPct * 100).toFixed(0)}% dev=${r.dev?.slice(0, 8)} priors=${
          r.devPriorTokens ?? "?"
        }`
      );
      console.log(`  h1 buys=${r.buyCountH1} sells=${r.sellCountH1} notes=${r.notes.join(", ") || "-"}`);
      console.log(`  symbol=${r.symbol} ageMin=${Math.round((Date.now() - r.pairCreatedAt) / 60000)}`);
    } else {
      console.log(`\n${mint}\n  REJECT [${verdict.reason}] (${ms}ms)`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
