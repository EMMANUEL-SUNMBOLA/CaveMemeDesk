import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { getFeed } from "../util/feed.js";
import type { Portfolio } from "../core/portfolio.js";
import type { Pipeline } from "../pipeline.js";
import type { RiskAgent } from "../agents/risk.js";

export interface DashboardHandle {
  stop: () => void;
}

const LEVEL_COLOR: Record<string, string> = {
  info: "gray",
  pass: "green",
  reject: "red",
  trade: "cyan",
  warn: "yellow",
  error: "magenta",
};

const CURVE_CHARS = "▁▂▃▄▅▆▇█";

function asciiCurve(values: number[], width = 60, height = 6): string[] {
  if (values.length === 0) return ["  (no equity data yet)"];
  const slice = values.slice(-width);
  if (slice.length === 1) slice.push(slice[0]);
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const range = max - min || 1;
  const lines: string[] = [];
  for (let row = height - 1; row >= 0; row--) {
    let line = "";
    for (const v of slice) {
      const norm = (v - min) / range; // 0..1
      const level = Math.round(norm * (CURVE_CHARS.length - 1));
      const rowLevel = Math.round((row / (height - 1)) * (CURVE_CHARS.length - 1));
      line += level >= rowLevel ? CURVE_CHARS[Math.min(level, CURVE_CHARS.length - 1)] : " ";
    }
    const label = row === height - 1 ? ` $${max.toFixed(0)}` : row === 0 ? ` $${min.toFixed(0)}` : "";
    lines.push(line + label);
  }
  return lines;
}

function fmtUsd(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m${s % 60}s`;
}

function Dashboard({
  portfolio,
  pipeline,
  risk,
  onTogglePause,
}: {
  portfolio: Portfolio;
  pipeline: Pipeline;
  risk: RiskAgent;
  onTogglePause: () => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [tick, setTick] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === " ") {
      onTogglePause();
      setPaused((p) => !p);
    }
  });

  void tick;
  const feed = getFeed(14);
  const equity = portfolio.equityUsd();
  const cash = portfolio.cashUsd;
  const day = portfolio.dayPnl();
  const positions = [...portfolio.positions.values()];
  const curve = portfolio.equityCurve.map((s) => s.equityUsd);
  const trades = portfolio.recentTrades.slice(-5).reverse();
  const t0 = startedAt;
  const totalPnl = equity - portfolio.startingBalanceUsd;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="magenta">
          CaveMemeDesk
        </Text>
        <Text>
          <Text bold backgroundColor={portfolio.killSwitchActive ? "red" : "green"} color="white">
            {" "}
            {portfolio.killSwitchActive ? " KILL-SWITCH " : " PAPER "}
          </Text>
          {paused ? (
            <Text bold backgroundColor="yellow" color="black">
              {" "}
              PAUSED{" "}
            </Text>
          ) : null}
          <Text color="gray"> {fmtAge(Date.now() - t0)} </Text>
        </Text>
      </Box>

      <Box borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
        <Text>
          <Text color="gray">Eq </Text>
          <Text bold color={totalPnl >= 0 ? "green" : "red"}>
            ${equity.toFixed(2)} ({totalPnl >= 0 ? "+" : ""}
            {((totalPnl / portfolio.startingBalanceUsd) * 100).toFixed(2)}%)
          </Text>
          <Text color="gray"> · Cash </Text>
          <Text color="cyan">${cash.toFixed(2)}</Text>
          <Text color="gray"> · Day </Text>
          <Text color={day.usd >= 0 ? "green" : "red"}>
            {day.usd >= 0 ? "+" : ""}
            {(day.pct * 100).toFixed(2)}%
          </Text>
          <Text color="gray"> · Pos </Text>
          <Text bold>{positions.length}</Text>
          <Text color="gray"> · SOL </Text>
          <Text color="cyan">${risk.solUsd.toFixed(2)}</Text>
        </Text>
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" width="50%" borderStyle="round" borderColor="gray" paddingX={1} marginRight={1}>
          <Text bold>Agent activity</Text>
          {feed.length === 0 ? (
            <Text color="gray">waiting for events…</Text>
          ) : (
            feed.map((e) => (
              <Text key={e.id}>
                <Text color="gray">{new Date(e.ts).toISOString().slice(11, 19)} </Text>
                <Text color={LEVEL_COLOR[e.level] ?? "white"}>{e.agent.padEnd(8)}</Text>
                <Text> {e.message.slice(0, 64)}</Text>
              </Text>
            ))
          )}
        </Box>

        <Box flexDirection="column" width="50%" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold>Open positions ({positions.length})</Text>
          {positions.length === 0 ? (
            <Text color="gray">flat — risk-free</Text>
          ) : (
            positions.map((p) => {
              const mark = portfolio.marks.get(p.mint) ?? p.entryPriceUsd;
              const pnlPct = ((mark - p.entryPriceUsd) / p.entryPriceUsd) * 100;
              const hold = fmtAge(Date.now() - p.entryTs);
              return (
                <Text key={p.mint}>
                  <Text color="cyan">{(p.symbol ?? p.mint.slice(0, 8)).padEnd(10)}</Text>
                  <Text> ${p.costUsd.toFixed(2)} </Text>
                  <Text color={pnlPct >= 0 ? "green" : "red"}>
                    {pnlPct >= 0 ? "+" : ""}
                    {pnlPct.toFixed(2)}%
                  </Text>
                  <Text color="gray">
                    {" "}
                    stop {(p.trailingActive ? "TRAIL" : ((p.stopPriceUsd / p.entryPriceUsd - 1) * 100).toFixed(1) + "%")} · {hold}
                  </Text>
                </Text>
              );
            })
          )}
          <Box marginTop={1} flexDirection="column">
            <Text bold>Equity curve</Text>
            {asciiCurve(curve).map((line, i) => (
              <Text key={i} color="cyan">
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
        <Text bold>
          Recent trades · seen {pipeline.stats.seen} · rejected {pipeline.stats.rejected} · passed{" "}
          {pipeline.stats.passedFilter} · traded {pipeline.stats.traded}
        </Text>
        {trades.length === 0 ? (
          <Text color="gray">no closed trades yet</Text>
        ) : (
          trades.map((t, i) => (
            <Text key={i}>
              <Text color="gray">{new Date(t.closedTs).toISOString().slice(11, 19)} </Text>
              <Text color="cyan">{(t.symbol ?? t.mint.slice(0, 8)).padEnd(10)}</Text>
              <Text color={t.pnlUsd >= 0 ? "green" : "red"}>
                {t.pnlUsd >= 0 ? "+" : "-"}${Math.abs(t.pnlUsd).toFixed(2)} ({(t.pnlPct * 100).toFixed(2)}%)
              </Text>
              <Text color="gray"> {t.closeReason} · hold {Math.round(t.holdSeconds / 60)}m</Text>
            </Text>
          ))
        )}
      </Box>

      <Text color="gray">[q] quit · [space] pause entries</Text>
    </Box>
  );
}

let startedAt = Date.now();

export function startDashboard(opts: {
  portfolio: Portfolio;
  pipeline: Pipeline;
  risk: RiskAgent;
  onTogglePause: () => void;
}): DashboardHandle {
  startedAt = Date.now();
  const app = render(<Dashboard {...opts} />);
  return {
    stop: () => {
      try {
        app.unmount();
        app.waitUntilExit();
      } catch {
        /* ignore */
      }
    },
  };
}
