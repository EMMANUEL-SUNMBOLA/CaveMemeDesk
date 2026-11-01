import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../util/db.js";

interface TradeRow {
  mint: string;
  symbol: string | null;
  opened_ts: number;
  closed_ts: number;
  cost_usd: number;
  proceeds_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  hold_seconds: number;
  open_reason: string;
  close_reason: string;
}

interface EquityRow {
  ts: number;
  equity_usd: number;
}

interface FunnelRow {
  action: string;
  n: number;
}

interface ReasonRow {
  reason: string;
  n: number;
}

const CURVE = "▁▂▃▄▅▆▇█";

function asciiCurve(values: number[], width = 60, height = 6): string[] {
  if (values.length === 0) return ["  (no equity data)"];
  const slice = values.slice(-width);
  if (slice.length === 1) slice.push(slice[0]);
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const range = max - min || 1;
  const lines: string[] = [];
  for (let row = height - 1; row >= 0; row--) {
    let line = "";
    for (const v of slice) {
      const level = Math.round(((v - min) / range) * (CURVE.length - 1));
      const rowLevel = Math.round((row / (height - 1)) * (CURVE.length - 1));
      line += level >= rowLevel ? CURVE[Math.min(level, CURVE.length - 1)] : " ";
    }
    lines.push(line + (row === height - 1 ? ` $${max.toFixed(2)}` : row === 0 ? ` $${min.toFixed(2)}` : ""));
  }
  return lines;
}

export function generateRecap(): string {
  const db = getDb();
  const trades = db
    .prepare(
      `SELECT mint, symbol, opened_ts, closed_ts, cost_usd, proceeds_usd, pnl_usd, pnl_pct,
              hold_seconds, open_reason, close_reason
       FROM trades ORDER BY closed_ts ASC`
    )
    .all() as unknown as TradeRow[];
  const equity = db
    .prepare("SELECT ts, equity_usd FROM equity_snapshots ORDER BY ts ASC")
    .all() as unknown as EquityRow[];
  const funnel = db
    .prepare("SELECT action, COUNT(*) as n FROM decisions GROUP BY action ORDER BY n DESC")
    .all() as unknown as FunnelRow[];
  const rejects = db
    .prepare(
      `SELECT reason, COUNT(*) as n FROM decisions
       WHERE action = 'rejected' GROUP BY reason ORDER BY n DESC LIMIT 15`
    )
    .all() as unknown as ReasonRow[];

  const wins = trades.filter((t) => t.pnl_usd > 0);
  const losses = trades.filter((t) => t.pnl_usd <= 0);
  const netPnl = trades.reduce((a, t) => a + t.pnl_usd, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl_usd, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl_usd, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgHoldMin =
    trades.length > 0 ? trades.reduce((a, t) => a + t.hold_seconds, 0) / trades.length / 60 : 0;

  // Max drawdown on equity curve
  let peak = -Infinity;
  let maxDd = 0;
  for (const s of equity) {
    if (s.equity_usd > peak) peak = s.equity_usd;
    if (peak > 0) {
      const dd = (peak - s.equity_usd) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }

  const best = trades.slice().sort((a, b) => b.pnl_usd - a.pnl_usd)[0];
  const worst = trades.slice().sort((a, b) => a.pnl_usd - b.pnl_usd)[0];

  const lines: string[] = [];
  lines.push("# CaveMemeDesk — Morning Performance Recap");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  if (trades.length === 0) {
    lines.push("No trades closed yet. The desk ran — the filters rejected everything (see funnel below).");
    lines.push("This is a valid outcome: the FILTER's job is to say no far more than yes.");
  } else {
    lines.push(`- **Trades closed:** ${trades.length} (wins ${wins.length} / losses ${losses.length})`);
    lines.push(`- **Win rate:** ${(winRate * 100).toFixed(1)}%`);
    lines.push(`- **Net PnL:** ${netPnl >= 0 ? "+" : "-"}$${Math.abs(netPnl).toFixed(4)}`);
    lines.push(`- **Profit factor:** ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`);
    lines.push(`- **Avg hold:** ${avgHoldMin.toFixed(0)} min`);
    lines.push(`- **Max drawdown:** ${(maxDd * 100).toFixed(2)}%`);
    const startEq = equity[0]?.equity_usd ?? null;
    const endEq = equity[equity.length - 1]?.equity_usd ?? null;
    if (startEq !== null && endEq !== null) {
      lines.push(`- **Equity:** $${startEq.toFixed(2)} → $${endEq.toFixed(2)} (${(((endEq - startEq) / startEq) * 100).toFixed(2)}%)`);
    }
  }
  lines.push("");
  lines.push("## Equity curve");
  lines.push("");
  lines.push("```");
  for (const l of asciiCurve(equity.map((e) => e.equity_usd))) lines.push(l);
  lines.push("```");
  if (trades.length > 0) {
    lines.push("");
    lines.push("## Best / worst");
    lines.push("");
    if (best)
      lines.push(
        `- Best: ${best.symbol ?? best.mint.slice(0, 8)} ${best.pnl_usd >= 0 ? "+" : "-"}$${Math.abs(best.pnl_usd).toFixed(4)} (${(best.pnl_pct * 100).toFixed(2)}%) — ${best.close_reason}`
      );
    if (worst)
      lines.push(
        `- Worst: ${worst.symbol ?? worst.mint.slice(0, 8)} ${worst.pnl_usd >= 0 ? "+" : "-"}$${Math.abs(worst.pnl_usd).toFixed(4)} (${(worst.pnl_pct * 100).toFixed(2)}%) — ${worst.close_reason}`
      );
  }
  lines.push("");
  lines.push("## Decision funnel");
  lines.push("");
  for (const f of funnel) lines.push(`- ${f.action}: ${f.n}`);
  lines.push("");
  lines.push("## Top rejection reasons");
  lines.push("");
  if (rejects.length === 0) lines.push("(none)");
  for (const r of rejects) lines.push(`- ${r.reason}: ${r.n}`);
  lines.push("");
  lines.push("## Closed trades");
  lines.push("");
  if (trades.length === 0) lines.push("(none)");
  for (const t of trades.slice(-30)) {
    const when = new Date(t.closed_ts).toISOString().slice(11, 16);
    lines.push(
      `- ${when} ${t.symbol ?? t.mint.slice(0, 8)} ${t.pnl_usd >= 0 ? "+" : "-"}$${Math.abs(t.pnl_usd).toFixed(4)} (${(t.pnl_pct * 100).toFixed(2)}%) hold ${Math.round(t.hold_seconds / 60)}m exit=${t.close_reason}`
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("*Paper mode. Modeled slippage — not live performance. Not financial advice.*");
  return lines.join("\n");
}

export function writeRecap(): string {
  const md = generateRecap();
  const dir = resolve(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `recap-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(path, md, "utf8");
  return path;
}

// CLI entry: npm run recap
if (process.argv[1] && process.argv[1].includes("morningReport")) {
  const md = generateRecap();
  const path = writeRecap();
  console.log(md);
  console.log(`\n[written to ${path}]`);
}
