# CaveMemeDesk

An autonomous Solana memecoin trading desk built around six specialized agents with hard handoffs. **Capital preservation first.** Runs in paper-trading mode; live trading is gated and disabled by default.

> **Status: implemented (v0.1, paper mode).** Full pipeline validated end-to-end against live APIs. Private research log + session history lives in `AGENTS.md` (gitignored).

## The six agents

```
PumpPortal WS ──► SCOUT ──► FILTER ──► ANALYST ──► EXECUTOR ──► RISK (owns position until exit)
                    │          │          │           │            │
                    └──────────┴──────────┴───────────┴────────────┴──► LOGGER (records every decision)
```

| # | Agent | Job |
|---|---|---|
| 1 | **SCOUT** | New pairs in real time — PumpPortal WS (`subscribeNewToken` + `subscribeMigration`) + Raydium AMM v4 `initialize2` logs. Dedup + bounded queue. |
| 2 | **FILTER** | Reject on: mint authority not revoked, freeze authority active, LP lock unverified/`< 50%`, top-10 holders `> 20%`, hourly volume `< $50k` (GeckoTerminal, summed across pools), dev-wallet rug history unknown/rugged, Token-2022 honeypot extensions, liquidity/age floors. **Unverifiable ⇒ reject.** Timing rejects (`too-new`, `no-dex-pair`, …) get up to 3 reschedules (5/15/45 min) — safety rejects are terminal. |
| 3 | **ANALYST** | Weighted 0–1 score (volume momentum .25, buy/sell .20, holders .15, liquidity .15, dev history .10, age .10, metadata .05). Reject `< 0.6`. |
| 4 | **EXECUTOR** | Paper fills only. **Max 8% of balance per position — hard cap double-checked at fill.** One position per mint (no averaging down, structurally). |
| 5 | **RISK** | Hard **-6% stop** every tick. Trailing **-3% from peak** activates only after **+12%**. 6h timeout exit. 3-loss → 60-min anti-revenge cooldown. Daily **-5% kill switch**. |
| 6 | **LOGGER** | Every trade/rejection/decision → SQLite (`data/desk.db`) with the *reason*; feeds UI + recap. |

## Quick start

```bash
npm install
npm start                    # paper mode + live terminal dashboard
npm start:headless           # overnight / no UI (logs to stdout)
npm run recap                # morning performance report (console + data/recap-*.md)
npm run typecheck
```

Flags / env:

```bash
npm start -- --config=config/test.json     # alternate thresholds (E2E testing)
npm start:headless -- --inject=<mint,...>  # seed candidates directly (dev testing)
RPC_URL=... .env                           # override free public RPC (Helius free tier recommended)
```

## Config

All thresholds live in `config/default.json` — no magic numbers in code:

- `filter.*` — volume $50k/h, top-10 20%, LP lock 50%, liquidity floor, age gate, dev policy
- `analyst.weights` + `minScore: 0.6`
- `executor.maxPositionPct: 0.08`, fees, slippage model
- `risk.*` — stops, trail, timeout, cooldown, kill switch
- `devHistoryPolicy: "reject-on-unknown"` (the safe default; `"best-effort-allow"` exists for test configs only)

`config/test.json` relaxes throughput thresholds (volume/age/top-10) **while keeping every authority/lock/honeypot safety check real** — used to validate the trade lifecycle.

## Live terminal

Ink dashboard (~1s refresh): mode badge (PAPER/kill-switch/paused), equity + cash + day PnL + positions, color-coded agent feed, open positions with live stop levels, ASCII equity curve, recent trades with exit reasons. Keys: `q` quit · `space` pause entries.

## Morning recap

Auto at 08:00 local (and on shutdown, and via `npm run recap`): win rate, net PnL, profit factor, max drawdown, best/worst trades with reasons, decision funnel, top rejection reasons, ASCII equity curve.

## Data sources (free tiers)

| Purpose | Source |
|---|---|
| New token / migration stream | PumpPortal WS (free methods only) |
| Mint/freeze authority, LP lock, holders, dev, rugged flags | RugCheck (free) |
| Token-2022 honeypot extensions | GoPlus (keyless) |
| Hourly volume (USD) | GeckoTerminal OHLCV (verified: `v` is already USD) |
| Pair existence / liquidity / price / age | DexScreener (keyless) |
| On-chain authority double-check | Solana RPC (public, with429-retry) |

## Ops: overnight run

```bash
nohup npm run start:headless > data/overnight.log 2>&1 &
tail -f data/overnight.log        # watch
npm run recap                      # morning
```

Free RPC rate-limits (`getTokenLargestAccounts` throttled) are retried, then fall back to RugCheck's verified holder data with a logged note — the condition is always verified by at least one source.

## Design notes

- **Graduated tokens only** — bonding-curve tokens fail LP-lock verification (reject, not assume). pump.fun now graduates to **PumpSwap**, not Raydium; SCOUT watches both migration + Raydium streams.
- **Not a sniping bot** — the $50k/h + LP-lock + maturity filters mean minutes+ latency by design. No Jito/gRPC/Rust needed.
- **Live trading is a stub**: requires `liveTradingEnabled=true` + `LIVE_TRADING=1` + key + would still refuse in v0.1. Recommended bar before even considering: ≥3 paper days / ≥30 trades.

```
config/          all tunables
src/agents/      the six agents
src/data/        PumpPortal / RugCheck / GoPlus / GeckoTerminal / DexScreener / RPC clients
src/core/        portfolio + paper engine, scoring, rugger DB
src/ui/          Ink dashboard
src/recap/       morning report
scripts/         checkToken.ts (per-token filter validator)
data/            SQLite db, logs, recaps (gitignored)
```

---

*Memecoin trading is extremely high-risk. Paper fills model slippage — not live performance. Research system, not financial advice.*
