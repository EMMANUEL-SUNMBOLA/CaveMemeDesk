import { loadConfig } from "./config.js";
import { openDb, closeDb } from "./util/db.js";
import { configureFeed, logEvent, onFeed } from "./util/feed.js";
import { configureLimiters } from "./util/rateLimit.js";
import { getSolUsd } from "./data/dexscreener.js";
import { Portfolio } from "./core/portfolio.js";
import { ExecutorAgent } from "./agents/executor.js";
import { RiskAgent } from "./agents/risk.js";
import { Pipeline } from "./pipeline.js";
import { generateRecap, writeRecap } from "./recap/morningReport.js";
import { TelegramNotifier } from "./telegram/telegram.js";

const headless = process.argv.includes("--headless");

async function main(): Promise<void> {
  const cfg = loadConfig();
  openDb("data/desk.db");
  configureLimiters(cfg.rateLimits);
  configureFeed({ ringSize: cfg.ui.feedSize, echo: headless });

  logEvent("LOGGER", "info", `CaveMemeDesk booting — mode=${cfg.mode}${headless ? " (headless)" : ""}`);

  let solUsd = await getSolUsd();
  if (!solUsd || solUsd <= 0) {
    solUsd = cfg.solUsdFallback;
    logEvent("LOGGER", "warn", `SOL price unavailable — using fallback $${cfg.solUsdFallback}`);
  } else {
    logEvent("LOGGER", "info", `SOL/USD $${solUsd.toFixed(2)}`);
  }

  const portfolio = new Portfolio({
    startingBalanceUsd: cfg.startingBalanceSol * solUsd,
    feePct: cfg.executor.feePct,
    slippageMinPct: cfg.executor.slippageMinPct,
    slippageMaxPct: cfg.executor.slippageMaxPct,
    maxPositionPct: cfg.executor.maxPositionPct,
    hardStopLossPct: cfg.risk.hardStopLossPct,
  });

  const risk = new RiskAgent(cfg, portfolio, solUsd);
  const executor = new ExecutorAgent(cfg, portfolio);
  const pipeline = new Pipeline(cfg, executor, risk);

  portfolio.snapshot();
  risk.start();
  pipeline.start();

  const togglePause = (): string => {
    if (portfolio.killSwitchActive) {
      portfolio.killSwitchActive = false;
      portfolio.killSwitchUntil = null;
      logEvent("LOGGER", "info", "entries resumed (manual)");
      return "entries resumed";
    }
    portfolio.killSwitchActive = true;
    portfolio.killSwitchUntil = null; // manual — no auto-expiry
    logEvent("LOGGER", "info", "entries paused (manual)");
    return "entries paused";
  };

  const fmtMin = (ms: number): string => `${Math.round(ms / 60_000)}min`;
  const telegram = new TelegramNotifier({
    enabled: cfg.telegram.enabled,
    sendTokenFinds: cfg.telegram.sendTokenFinds,
    sendTrades: cfg.telegram.sendTrades,
    sendAlerts: cfg.telegram.sendAlerts,
    sendRecap: cfg.telegram.sendRecap,
    sendRejections: cfg.telegram.sendRejections,
    handlers: {
      status: () => {
        const eq = portfolio.equityUsd();
        const day = portfolio.dayPnl();
        const pnlPct = (eq / portfolio.startingBalanceUsd - 1) * 100;
        const lines = [
          `mode: ${cfg.mode} · kill: ${portfolio.killSwitchActive ? "ON" : "off"}` +
            (portfolio.cooldownUntil ? ` · cooldown ${fmtMin(portfolio.cooldownUntil - Date.now())}` : ""),
          `equity $${eq.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%) · cash $${portfolio.cashUsd.toFixed(2)}`,
          `day ${day.usd >= 0 ? "+" : "-"}$${Math.abs(day.usd).toFixed(2)} (${(day.pct * 100).toFixed(2)}%) · open ${portfolio.positions.size}`,
          `seen ${pipeline.stats.seen} · rejected ${pipeline.stats.rejected} · traded ${pipeline.stats.traded}`,
          `trailing: +${(cfg.risk.trailActivationPct * 100).toFixed(0)}% act @ -${(cfg.risk.trailDistancePct * 100).toFixed(0)}% · SL -${(cfg.risk.hardStopLossPct * 100).toFixed(0)}% · timeout ${cfg.risk.timeoutExitHours}h`,
        ];
        return lines.join("\n");
      },
      pause: togglePause,
      resume: togglePause,
      recap: generateRecap,
    },
  });
  telegram.start();
  void telegram.send(
    `<b>🖥 CaveMemeDesk online</b>\nmode=<code>${cfg.mode}</code>${headless ? " · headless" : ""} · SOL $${solUsd.toFixed(2)}\nuptime starts now`
  );

  // Test hook: --inject=mint1,mint2 seeds candidates directly (skips scouting)
  const injectArg = process.argv.find((a) => a.startsWith("--inject="));
  if (injectArg) {
    for (const mint of injectArg.slice("--inject=".length).split(",").map((s) => s.trim()).filter(Boolean)) {
      logEvent("LOGGER", "info", `injected test candidate ${mint}`);
      pipeline.enqueue({ mint, source: "raydium-init", ts: Date.now() });
    }
  }

  // Equity sampler
  const equityTimer = setInterval(() => portfolio.snapshot(), cfg.ui.equitySnapshotMs);

  // Auto recap at configured local hour (once per day)
  let recapFiredFor = "";
  const recapTimer = setInterval(() => {
    if (!cfg.recap.auto) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() === cfg.recap.autoHourLocal && recapFiredFor !== today) {
      recapFiredFor = today;
      const md = generateRecap();
      const path = writeRecap();
      logEvent("LOGGER", "info", `morning recap written → ${path}`);
      telegram.sendRecap(md, "🌅 morning recap");
    }
  }, 60_000);

  let dashboard: { stop: () => void } | null = null;
  let headlessTimer: NodeJS.Timeout | null = null;

  if (headless) {
    headlessTimer = setInterval(() => {
      const eq = portfolio.equityUsd();
      const day = portfolio.dayPnl();
      logEvent(
        "LOGGER",
        "info",
        `equity $${eq.toFixed(2)} cash $${portfolio.cashUsd.toFixed(2)} open=${portfolio.positions.size} day=${(day.pct * 100).toFixed(2)}% seen=${pipeline.stats.seen} rejected=${pipeline.stats.rejected} traded=${pipeline.stats.traded}`
      );
    }, 300_000);
    logEvent("LOGGER", "info", "running headless — ctrl+c to stop");
  } else {
    const { startDashboard } = await import("./ui/dashboard.js");
    dashboard = startDashboard({
      portfolio,
      pipeline,
      risk,
      onTogglePause: togglePause,
    });
  }

  const shutdown = (sig: string) => {
    logEvent("LOGGER", "warn", `shutdown (${sig}) — final snapshot`);
    let md = "";
    try {
      pipeline.stop();
      risk.stop();
      clearInterval(equityTimer);
      clearInterval(recapTimer);
      if (headlessTimer) clearInterval(headlessTimer);
      portfolio.snapshot();
      md = generateRecap();
      const path = writeRecap();
      logEvent("LOGGER", "info", `shutdown recap → ${path}`);
    } catch (err) {
      console.error("shutdown error:", err);
    } finally {
      dashboard?.stop();
      if (md) telegram.sendRecap(md, `⏹ shutdown recap (${sig})`);
      void telegram
        .stop(2500)
        .catch(() => {})
        .finally(() => {
          closeDb();
          process.exit(0);
        });
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  onFeed(() => {
    /* feed consumed by UI ring; presence keeps listener path warm */
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
