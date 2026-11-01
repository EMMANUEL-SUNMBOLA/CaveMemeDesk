import { isKnownRugger, upsertRugger } from "../util/db.js";

export function noteRugger(wallet: string, ruggedCount: number, source: string): void {
  try {
    upsertRugger(wallet, ruggedCount, source);
  } catch {
    /* db not ready */
  }
}

export function checkKnownRugger(wallet: string): boolean {
  try {
    return isKnownRugger(wallet);
  } catch {
    return false;
  }
}
