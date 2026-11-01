import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { Candidate } from "../types.js";
import { logEvent } from "../util/feed.js";

const DATA_URL_BASE = "wss://pumpportal.fun/api/data";

function dataUrl(): string {
  const key = process.env.PUMPPORTAL_API_KEY?.trim();
  return key ? `${DATA_URL_BASE}?api-key=${encodeURIComponent(key)}` : DATA_URL_BASE;
}

interface RawTokenEvent {
  mint?: string;
  name?: string;
  symbol?: string;
  traderPublicKey?: string;
  pool?: string;
  uri?: string;
  marketCapSol?: number;
  txType?: string;
}

export class PumpPortalClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private lastMessageAt = 0;

  start(): void {
    this.closed = false;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(dataUrl());
    } catch (err) {
      logEvent("SCOUT", "error", `PumpPortal connect failed: ${err instanceof Error ? err.message : err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      logEvent("SCOUT", "info", "PumpPortal WS connected — subscribing newToken + migration");
      this.ws?.send(JSON.stringify({ method: "subscribeNewToken" }));
      this.ws?.send(JSON.stringify({ method: "subscribeMigration" }));
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(raw.toString()) as RawTokenEvent & { message?: string };
        if (!msg.mint) return;
        const base = {
          mint: msg.mint,
          name: msg.name,
          symbol: msg.symbol,
          dev: msg.traderPublicKey,
          pool: msg.pool,
          ts: Date.now(),
        };
        // Migration events have txType "migrate" / explicit pool; creation events have txType create/initial-buy
        const txType = (msg.txType ?? "").toLowerCase();
        if (txType.includes("migrate")) {
          this.emit("candidate", { ...base, source: "pumpportal-migration" } satisfies Candidate);
        } else {
          this.emit("candidate", { ...base, source: "pumpportal-create" } satisfies Candidate);
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    this.ws.on("close", () => {
      if (!this.closed) {
        logEvent("SCOUT", "warn", "PumpPortal WS closed — reconnecting");
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err: Error) => {
      logEvent("SCOUT", "error", `PumpPortal WS error: ${err.message}`);
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
