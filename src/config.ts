import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  mode: z.enum(["paper", "live"]).default("paper"),
  startingBalanceSol: z.number().positive(),
  solUsdFallback: z.number().positive(),
  liveTradingEnabled: z.boolean().default(false),
  pipeline: z.object({
    queueMax: z.number().int().positive(),
    concurrency: z.number().int().positive(),
    minTokenAgeMs: z.number().int().nonnegative(),
    dedupeTtlMs: z.number().int().positive(),
  }),
  filter: z.object({
    minLiquidityUsd: z.number().nonnegative(),
    minHourlyVolumeUsd: z.number().nonnegative(),
    maxTop10Pct: z.number().min(0).max(1),
    lpLockMinPct: z.number().min(0).max(1),
    devRugSampleSize: z.number().int().min(0).max(10),
    // "reject-on-unknown" = user's chosen safety policy (default)
    // "best-effort-allow" = TEST-ONLY escape hatch, allows trades with unverifiable dev history
    devHistoryPolicy: z.enum(["reject-on-unknown", "best-effort-allow"]),
  }),
  analyst: z.object({
    minScore: z.number().min(0).max(1),
    weights: z.object({
      volumeMomentum: z.number(),
      buySellRatio: z.number(),
      holderDistribution: z.number(),
      liquidityDepth: z.number(),
      devHistory: z.number(),
      ageSweetSpot: z.number(),
      metadataHeuristics: z.number(),
    }),
  }),
  executor: z.object({
    maxPositionPct: z.number().min(0).max(1),
    feePct: z.number().min(0),
    slippageMinPct: z.number().min(0),
    slippageMaxPct: z.number().min(0),
  }),
  risk: z.object({
    hardStopLossPct: z.number().min(0).max(1),
    trailActivationPct: z.number().min(0),
    trailDistancePct: z.number().min(0).max(1),
    timeoutExitHours: z.number().positive(),
    consecutiveLossesToCooldown: z.number().int().positive(),
    cooldownMinutes: z.number().positive(),
    dailyKillSwitchPct: z.number().min(0).max(1),
    tickMs: z.number().int().positive(),
  }),
  scout: z.object({
    raydiumEnabled: z.boolean(),
    raydiumAmmV4Program: z.string(),
    raydiumBackoffMs: z.number().int().positive(),
  }),
  rpc: z.object({
    url: z.string().url(),
  }),
  rateLimits: z.object({
    dexscreenerMinIntervalMs: z.number().int().positive(),
    geckoterminalMinIntervalMs: z.number().int().positive(),
    rugcheckMinIntervalMs: z.number().int().positive(),
    goplusMinIntervalMs: z.number().int().positive(),
    rpcMinIntervalMs: z.number().int().positive(),
  }),
  ui: z.object({
    refreshMs: z.number().int().positive(),
    equitySnapshotMs: z.number().int().positive(),
    feedSize: z.number().int().positive(),
  }),
  recap: z.object({
    auto: z.boolean(),
    autoHourLocal: z.number().int().min(0).max(23),
  }),
});

export type DeskConfig = z.infer<typeof configSchema>;

function loadDotEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function configPath(): string {
  const fromArg = process.argv.find((a) => a.startsWith("--config="));
  if (fromArg) return fromArg.slice("--config=".length);
  if (process.env.DESK_CONFIG) return process.env.DESK_CONFIG;
  return "config/default.json";
}

export function loadConfig(): DeskConfig {
  const path = configPath();
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
  const fileEnv = loadDotEnv();
  // dotenv convention: real environment wins, .env fills gaps — publish all to
  // process.env so any module (pumpportal, rpc, …) can read keys directly.
  for (const [k, v] of Object.entries(fileEnv)) {
    if (v !== undefined && process.env[k] === undefined) process.env[k] = v;
  }
  const env = { ...process.env };
  if (env.RPC_URL) raw.rpc = { ...raw.rpc, url: env.RPC_URL };
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("Invalid config/default.json:");
    console.error(parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
    process.exit(1);
  }
  const cfg = parsed.data;

  if (cfg.mode === "live" || cfg.liveTradingEnabled) {
    const liveOk = env.LIVE_TRADING === "1" && !!env.PRIVATE_KEY && cfg.liveTradingEnabled;
    if (!liveOk) {
      console.error(
        "LIVE TRADING REFUSED: requires liveTradingEnabled=true in config, LIVE_TRADING=1 and PRIVATE_KEY in .env. " +
          "The live execution engine is a stub and is not implemented in v0.1 — paper mode only."
      );
      process.exit(1);
    }
    console.error("LIVE TRADING GATE: liveEngine is not implemented in v0.1. Falling back to paper mode.");
    cfg.mode = "paper";
    cfg.liveTradingEnabled = false;
  }
  return cfg;
}

export const env = () => ({ ...process.env, ...loadDotEnv() });
