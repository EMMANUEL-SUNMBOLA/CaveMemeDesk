import { fetchJson } from "../util/http.js";
import { limiters } from "../util/rateLimit.js";

export interface RugCheckSummary {
  mintAuthorityRevoked: boolean | null; // null = unverifiable, true = revoked
  freezeAuthorityRevoked: boolean | null;
  top10Pct: number | null;
  lpLockedPct: number | null;
  creator: string | null;
  rugged: boolean | null;
  tokenProgram: string | null;
  creatorTokens: Array<{ mint: string; marketCap?: number; createdAt?: string }> | null;
  raw: unknown;
}

const TOKEN_PROGRAM_SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const isClassicSplToken = (p: string | null): boolean => !p || p === TOKEN_PROGRAM_SPL;

function authorityRevoked(v: unknown): boolean | null {
  if (v === undefined) return null; // field absent = unverifiable
  if (v === null) return true; // explicit JSON null = no authority = revoked
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "" || s === "null" || s === "none") return true;
    return false; // any base58 = active
  }
  if (typeof v === "object") {
    const obj = v as { authority?: unknown[]; status?: string | number };
    if (Array.isArray(obj.authority)) return obj.authority.length === 0;
    if (obj.status !== undefined) return String(obj.status) === "0";
    return Object.keys(obj).length === 0;
  }
  return null;
}

/**
 * RugCheck percent fields (holders[].pct, lp.lpLockedPct, …) are PERCENT scale:
 * 9.48 means 9.48%. Always /100. (A >1 heuristic would misread 0.42% as 42%.)
 * Verified against live responses 2026-11.
 */
function pctToFraction(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v / 100;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v) / 100;
  return null;
}

/** Max lpLockedPct across markets — real path is markets[i].lp.lpLockedPct. */
function findMaxLpLockedPct(markets: unknown): number | null {
  if (!Array.isArray(markets)) return null;
  let best: number | null = null;
  for (const m of markets) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    for (const key of ["lpLockedPct", "lp_locked_pct", "lockedPct", "lpLockPct"]) {
      const pct = pctToFraction(obj[key]);
      if (pct !== null && (best === null || pct > best)) best = pct;
    }
    const lp = obj.lp as Record<string, unknown> | undefined;
    if (lp && typeof lp === "object") {
      for (const key of ["lpLockedPct", "lockedPct", "lpLockPct"]) {
        const pct = pctToFraction(lp[key]);
        if (pct !== null && (best === null || pct > best)) best = pct;
      }
    }
  }
  return best;
}

function extractTop10Pct(report: Record<string, unknown>): number | null {
  const holders = (report.holders ?? report.topHolders) as unknown;
  if (!Array.isArray(holders) || holders.length === 0) return null;
  const pcts: number[] = [];
  for (const h of holders) {
    if (!h || typeof h !== "object") continue;
    const pct = pctToFraction((h as Record<string, unknown>).pct);
    if (pct !== null) pcts.push(pct);
  }
  if (pcts.length === 0) return null;
  pcts.sort((a, b) => b - a);
  return pcts.slice(0, 10).reduce((a, b) => a + b, 0);
}

export async function getRugCheckReport(mint: string): Promise<RugCheckSummary | null> {
  await limiters.rugcheck.wait();
  let res = await fetchJson<Record<string, unknown>>(
    `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`,
    { timeoutMs: 15000 }
  );
  if (!res.ok) {
    await limiters.rugcheck.wait();
    res = await fetchJson<Record<string, unknown>>(
      `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report/quick`,
      { timeoutMs: 15000 }
    );
  }
  if (!res.ok || !res.data || typeof res.data !== "object") return null;
  if ("error" in res.data) return null; // {"error": ...} = token not indexed yet

  const report = res.data;
  const tokenObj = (report.token ?? {}) as Record<string, unknown>;

  // Authorities: top-level preferred, nested token.* as fallback. null = revoked, absent = unknown.
  const mintAuth =
    report.mintAuthority !== undefined ? report.mintAuthority : tokenObj.mintAuthority;
  const freezeAuth =
    report.freezeAuthority !== undefined ? report.freezeAuthority : tokenObj.freezeAuthority;

  const creatorRaw = report.creator;
  const creator = typeof creatorRaw === "string" && creatorRaw.length >= 32 ? creatorRaw : null;

  const creatorTokensRaw = report.creatorTokens;
  const creatorTokens = Array.isArray(creatorTokensRaw)
    ? (creatorTokensRaw.filter(
        (t) => t && typeof t === "object" && typeof (t as { mint?: unknown }).mint === "string"
      ) as RugCheckSummary["creatorTokens"])
    : null;

  const ruggedRaw = report.rugged;
  const tokenProgramRaw = report.tokenProgram;

  return {
    mintAuthorityRevoked: authorityRevoked(mintAuth),
    freezeAuthorityRevoked: authorityRevoked(freezeAuth),
    top10Pct: extractTop10Pct(report),
    lpLockedPct: findMaxLpLockedPct(report.markets),
    creator,
    rugged: typeof ruggedRaw === "boolean" ? ruggedRaw : null,
    tokenProgram: typeof tokenProgramRaw === "string" ? tokenProgramRaw : null,
    creatorTokens,
    raw: report,
  };
}
