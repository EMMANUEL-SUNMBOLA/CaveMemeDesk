import { fetchJson } from "../util/http.js";
import { limiters } from "../util/rateLimit.js";

export interface GoPlusReport {
  authoritiesKnown: boolean;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  transferHook: boolean | null; // true = hook present (only meaningful for Token-2022)
  defaultAccountStateFrozen: boolean | null;
  balanceMutableAuthority: boolean | null;
  nonTransferable: boolean | null;
  transferFeeActive: boolean | null;
  raw: unknown;
}

function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

/** GoPlus authority shape: {authority: string[], status: "0"|"1"} | null | string. */
function isRevoked(v: unknown): boolean | null {
  if (v === null) return true;
  if (v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "" || s === "null" || s === "none" || s === "0") return true;
    return false;
  }
  if (typeof v === "boolean") return !v;
  if (typeof v === "object") {
    const obj = v as { authority?: unknown; status?: unknown };
    if (Array.isArray(obj.authority)) return obj.authority.length === 0;
    if (obj.status !== undefined) return String(obj.status) === "0";
    return Object.keys(obj).length === 0;
  }
  return null;
}

/** Extension flags: arrays (length>0 = present) or {authority,status} objects. */
function extActive(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || s === "null" || s === "0" || s === "false") return false;
    if (s === "1" || s === "true") return true;
    return null;
  }
  if (typeof v === "boolean") return v;
  if (typeof v === "object") {
    const obj = v as { authority?: unknown; status?: unknown };
    if (Array.isArray(obj.authority)) return obj.authority.length > 0;
    if (obj.status !== undefined) return String(obj.status) === "1";
    return Object.keys(v as object).length > 0;
  }
  return null;
}

interface TokenSecurityEnvelope {
  code?: number;
  message?: string;
  result?: Record<string, Record<string, unknown>>;
}

export async function getGoPlusReport(mint: string): Promise<GoPlusReport | null> {
  await limiters.goplus.wait();
  const res = await fetchJson<TokenSecurityEnvelope>(
    `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(mint)}`,
    { timeoutMs: 12000 }
  );
  if (!res.ok || !res.data || typeof res.data !== "object") return null;

  const root = res.data.result ?? (res.data as unknown as Record<string, Record<string, unknown>>);
  const token = root[mint] ?? root[Object.keys(root)[0] ?? ""];
  if (!token || typeof token !== "object") return null;
  // Empty object = token unknown to GoPlus = unverifiable
  if (Object.keys(token).length === 0) return null;

  // GoPlus Solana: mintable/freezable are {authority[], status} objects at the token root
  const mintable = token.mintable as Record<string, unknown> | undefined;
  const freezable = token.freezable as Record<string, unknown> | undefined;
  const mintAuth = isRevoked(
    mintable !== undefined ? mintable : pick(token, "mint_authority", "mintAuthority")
  );
  const freezeAuth = isRevoked(
    freezable !== undefined ? freezable : pick(token, "freeze_authority", "freezeAuthority")
  );

  const hookRaw = pick(token, "transfer_hook") ?? pick(token, "transferHook");
  const stateRaw = pick(token, "default_account_state") ?? pick(token, "defaultAccountState");
  const balanceRaw = pick(token, "balance_mutable_authority", "balanceMutableAuthority");
  const nonXferRaw = pick(token, "non_transferable", "nonTransferable");
  const feeRaw = pick(token, "transfer_fee", "transferFee");

  return {
    authoritiesKnown: mintAuth !== null || freezeAuth !== null,
    mintAuthorityRevoked: mintAuth,
    freezeAuthorityRevoked: freezeAuth,
    transferHook: extActive(hookRaw),
    defaultAccountStateFrozen: extActive(stateRaw),
    balanceMutableAuthority: extActive(balanceRaw),
    nonTransferable: extActive(nonXferRaw),
    transferFeeActive: extActive(feeRaw),
    raw: token,
  };
}
