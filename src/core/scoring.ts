import type { ScoreBreakdown, ScoreResult, SecurityReport } from "../types.js";

function clamp(v: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, v));
}

export function computeScore(
  report: SecurityReport,
  weights: ScoreBreakdown,
  now = Date.now()
): ScoreResult {
  // Volume momentum: current hour vs 24h average hour. 2x average → 1.0
  let volumeMomentum: number;
  const avgHour = report.volumeH24Usd !== null && report.volumeH24Usd > 0 ? report.volumeH24Usd / 24 : null;
  if (avgHour && avgHour > 0) {
    volumeMomentum = clamp(report.hourlyVolumeUsd / avgHour / 2);
  } else {
    volumeMomentum = clamp(report.hourlyVolumeUsd / 200000); // fallback: $200k/h → 1.0
  }

  // Buy/sell ratio last hour: ratio 0.5 → 0, ratio 3+ → 1
  let buySellRatio: number;
  if (report.buyCountH1 !== null && report.sellCountH1 !== null) {
    const ratio = report.buyCountH1 / Math.max(report.sellCountH1, 1);
    buySellRatio = clamp((ratio - 0.5) / 2.5);
  } else {
    buySellRatio = 0.5; // neutral when unknown (hard volume filter already passed)
  }

  // Holder distribution: top10 0.25 → 0, top10 0.05 → 1
  const holderDistribution = clamp((0.25 - report.top10Pct) / 0.2);

  // Liquidity depth: $10k → 0, $100k → 1
  const liquidityDepth = clamp((report.liquidityUsd - 10000) / 90000);

  // Dev history margin: prior tokens reduce score (clean but busy devs slightly discounted)
  const devHistory =
    report.devPriorTokens !== null ? clamp(1 - report.devPriorTokens / 10) : 0.8;

  // Age sweet spot: full score 30min–48h, taper to 0 at 10min and 7d
  const ageMin = (now - report.pairCreatedAt) / 60000;
  let ageSweetSpot: number;
  if (ageMin <= 10) ageSweetSpot = 0;
  else if (ageMin < 30) ageSweetSpot = (ageMin - 10) / 20;
  else if (ageMin <= 48 * 60) ageSweetSpot = 1;
  else if (ageMin <= 7 * 24 * 60) ageSweetSpot = 1 - (ageMin - 48 * 60) / (7 * 24 * 60 - 48 * 60);
  else ageSweetSpot = 0;

  // Metadata heuristics
  let meta = 0;
  let checks = 0;
  const sym = report.symbol ?? "";
  const name = report.name ?? "";
  checks++;
  if (sym.length >= 2 && sym.length <= 8) meta += 1;
  checks++;
  if (name.length > 0 && name.length <= 40) meta += 1;
  checks++;
  if (!/[^\w\s$.-]/.test(sym)) meta += 1;
  const metadataHeuristics = meta / checks;

  const breakdown: ScoreBreakdown = {
    volumeMomentum,
    buySellRatio,
    holderDistribution,
    liquidityDepth,
    devHistory,
    ageSweetSpot,
    metadataHeuristics,
  };

  const score =
    volumeMomentum * weights.volumeMomentum +
    buySellRatio * weights.buySellRatio +
    holderDistribution * weights.holderDistribution +
    liquidityDepth * weights.liquidityDepth +
    devHistory * weights.devHistory +
    ageSweetSpot * weights.ageSweetSpot +
    metadataHeuristics * weights.metadataHeuristics;

  return { score: clamp(score), breakdown };
}
