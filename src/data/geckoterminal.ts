import { fetchJson } from "../util/http.js";
import { limiters } from "../util/rateLimit.js";

interface OhlcvResponse {
  data?: { attributes?: { ohlcv_list?: Array<number[]> } };
}

const okCache = new Map<string, number>(); // pool → usd volume
const failCache = new Map<string, number>(); // pool → ts of failure
const OK_TTL_MS = 120_000;
const FAIL_TTL_MS = 15_000;

/**
 * Latest hourly candle volume in USD for a pool.
 * NOTE (verified empirically 2026-11): GeckoTerminal OHLCV `v` is already USD
 * normalized regardless of quote asset — do NOT multiply by quote price.
 * Failures cached briefly (15s) so transient 429s recover quickly.
 */
export async function getHourlyVolumeUsd(poolAddress: string): Promise<number | null> {
  const okHit = okCache.get(poolAddress);
  if (okHit !== undefined) return okHit;
  const failHit = failCache.get(poolAddress);
  if (failHit !== undefined && Date.now() - failHit < FAIL_TTL_MS) return null;

  await limiters.geckoterminal.wait();
  const res = await fetchJson<OhlcvResponse>(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(
      poolAddress
    )}/ohlcv/hour?aggregate=1&limit=2`,
    { timeoutMs: 12000 }
  );

  let value: number | null = null;
  if (res.ok && res.data?.data?.attributes?.ohlcv_list) {
    const list = res.data.data.attributes.ohlcv_list;
    if (Array.isArray(list) && list.length > 0) {
      const newest = list[0];
      const vol = newest?.[5];
      const ts = (newest?.[0] ?? 0) * 1000;
      const fresh = ts === 0 || Date.now() - ts < 2 * 3600_000;
      if (typeof vol === "number" && Number.isFinite(vol) && vol >= 0 && fresh) {
        value = vol;
      }
    }
  }

  if (value !== null) {
    okCache.set(poolAddress, value);
    failCache.delete(poolAddress);
    if (okCache.size > 500) {
      const oldest = okCache.keys().next().value;
      if (oldest) okCache.delete(oldest);
    }
  } else {
    failCache.set(poolAddress, Date.now());
  }
  return value;
}
