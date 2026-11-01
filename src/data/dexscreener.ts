import { fetchJson } from "../util/http.js";
import { limiters } from "../util/rateLimit.js";
import type { DexPairInfo } from "../types.js";

interface RawPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h1?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export type DexResult =
  | { kind: "ok"; pair: DexPairInfo; pools: string[]; name?: string; symbol?: string }
  | { kind: "not-found" }
  | { kind: "error"; error: string };

export async function getBestSolanaPair(mint: string): Promise<DexResult> {
  await limiters.dexscreener.wait();
  const res = await fetchJson<RawPair[]>(
    `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`,
    { timeoutMs: 10000 }
  );
  if (!res.ok) return { kind: "error", error: res.error };
  if (!Array.isArray(res.data) || res.data.length === 0) return { kind: "not-found" };

  const pairs = res.data.filter((p) => p.chainId === "solana" && p.pairAddress);
  if (pairs.length === 0) return { kind: "not-found" };

  const sorted = [...pairs].sort((a, b) => {
    const la = toNum(a.liquidity?.usd) ?? -1;
    const lb = toNum(b.liquidity?.usd) ?? -1;
    return lb - la;
  });
  const pools = sorted.slice(0, 3).map((p) => p.pairAddress!);
  const best = sorted[0];

  const info: DexPairInfo = {
    pairAddress: best.pairAddress!,
    dexId: best.dexId ?? "unknown",
    priceUsd: toNum(best.priceUsd),
    liquidityUsd: toNum(best.liquidity?.usd),
    volumeH24Usd: toNum(best.volume?.h24),
    buysH1: toNum(best.txns?.h1?.buys),
    sellsH1: toNum(best.txns?.h1?.sells),
    pairCreatedAt: typeof best.pairCreatedAt === "number" ? best.pairCreatedAt : null,
  };
  return { kind: "ok", pair: info, pools, name: best.baseToken?.name, symbol: best.baseToken?.symbol };
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

export async function getSolUsd(): Promise<number | null> {
  const r = await getBestSolanaPair(SOL_MINT);
  return r.kind === "ok" ? r.pair.priceUsd : null;
}
