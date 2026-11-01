import { Connection, PublicKey } from "@solana/web3.js";
import { limiters } from "../util/rateLimit.js";

export interface MintOnChainInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyRaw: bigint | null;
  decimals: number | null;
}

export interface HolderCheck {
  top10Pct: number | null;
  supplyRaw: bigint | null;
  error?: string;
}

let conn: Connection | null = null;

export function getConnection(url: string): Connection {
  if (!conn) conn = new Connection(url, { commitment: "confirmed" });
  return conn;
}

/** Free public RPC 429s specific methods — retry with backoff before giving up. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delaysMs = [2500, 6000]): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch {
      if (i < delaysMs.length) {
        const wait = delaysMs[i] ?? 6000;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  return null;
}

export async function getMintInfo(url: string, mint: string): Promise<MintOnChainInfo | null> {
  await limiters.rpc.wait();
  const conn = getConnection(url);
  const res = await withRetry(() => conn.getParsedAccountInfo(new PublicKey(mint)));
  if (!res || !res.value || !("parsed" in res.value.data)) return null;
  const info = res.value.data.parsed?.info;
  if (!info) return null;
  const supplyStr: string | undefined = info.supply;
  return {
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    supplyRaw: supplyStr !== undefined ? BigInt(supplyStr) : null,
    decimals: typeof info.decimals === "number" ? info.decimals : null,
  };
}

export async function getTop10HolderPct(url: string, mint: string, supplyRaw?: bigint | null): Promise<HolderCheck> {
  await limiters.rpc.wait();
  const conn = getConnection(url);
  const largest = await withRetry(() => conn.getTokenLargestAccounts(new PublicKey(mint)));
  if (!largest?.value || largest.value.length === 0) {
    return { top10Pct: null, supplyRaw: supplyRaw ?? null, error: "rpc-throttled-or-empty" };
  }

  let supply = supplyRaw;
  if (supply === undefined || supply === null) {
    const mintInfo = await getMintInfo(url, mint);
    supply = mintInfo?.supplyRaw ?? null;
  }
  if (!supply || supply === 0n) return { top10Pct: null, supplyRaw: supply, error: "no-supply" };

  let top10 = 0n;
  for (const acc of largest.value.slice(0, 10)) {
    try {
      top10 += BigInt(acc.amount);
    } catch {
      /* skip malformed */
    }
  }
  return { top10Pct: Number(top10) / Number(supply), supplyRaw: supply };
}
