import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { FeedEvent } from "../types.js";
import { onFeed, logEvent } from "../util/feed.js";

const API = "https://api.telegram.org";
const SEND_INTERVAL_MS = 1200; // ~50 msg/min — safely under per-chat limits
const QUEUE_MAX = 100;
const SPLIT_AT = 3900; // Telegram hard limit is 4096 chars

export interface TelegramHandlers {
  status: () => string;
  pause: () => string;
  resume: () => string;
  recap: () => string;
}

export interface TelegramOptions {
  enabled: boolean;
  sendTokenFinds: boolean;
  sendTrades: boolean;
  sendAlerts: boolean;
  sendRecap: boolean;
  sendRejections: boolean;
  handlers: TelegramHandlers;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadPersistedChatId(): string | null {
  try {
    const p = resolve(process.cwd(), "data/telegram.json");
    if (!existsSync(p)) return null;
    const v = JSON.parse(readFileSync(p, "utf8")).chatId;
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

function persistChatId(chatId: string): void {
  try {
    const dir = resolve(process.cwd(), "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "telegram.json"), JSON.stringify({ chatId }, null, 2));
  } catch {
    /* non-fatal */
  }
}

/**
 * Telegram alert channel: token finds, trades, alerts, daily recap.
 * - Outbound: FIFO queue, 1.2s spacing, HTML parse mode, never throws into the desk.
 * - Inbound: getUpdates long-poll for chat-id auto-capture + /commands.
 * - No new deps — plain fetch() against api.telegram.org.
 */
export class TelegramNotifier {
  private queue: string[] = [];
  private pumping = false;
  private chatId: string | null;
  private aborted = false;
  private abort = new AbortController();
  private offset = -1;
  private offFeed: (() => void) | null = null;
  private drops = 0;

  constructor(private opts: TelegramOptions) {
    const envChat = process.env.TELEGRAM_CHAT_ID?.trim();
    this.chatId = envChat || loadPersistedChatId() || null;
  }

  get token(): string | null {
    return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
  }

  get ready(): boolean {
    return this.opts.enabled && !!this.token && !!this.chatId;
  }

  start(): void {
    if (!this.opts.enabled) {
      logEvent("LOGGER", "info", "telegram: disabled in config");
      return;
    }
    if (!this.token) {
      logEvent("LOGGER", "warn", "telegram: enabled but TELEGRAM_BOT_TOKEN missing — alerts off");
      return;
    }
    this.offFeed = onFeed((e) => this.onFeedEvent(e));
    this.pollLoop();
    if (this.chatId) {
      logEvent("LOGGER", "info", `telegram: linked chat ${this.chatId} — alerts live`);
    } else {
      logEvent("LOGGER", "info", "telegram: no chat linked — send /start to the bot to enable alerts");
    }
  }

  /** Send an arbitrary HTML-safe message (emoji allowed, user text must be pre-escaped). */
  send(html: string): void {
    if (!this.opts.enabled || !this.token || !this.chatId) return;
    for (const part of this.split(html)) {
      if (this.queue.length >= QUEUE_MAX) {
        this.queue.shift();
        this.drops++;
        if (this.drops === 1 || this.drops % 50 === 0) {
          logEvent("LOGGER", "warn", `telegram: queue full — dropped ${this.drops} message(s)`);
        }
      }
      this.queue.push(part);
    }
    void this.pump();
  }

  sendRecap(recapMd: string, label: string): void {
    if (!this.opts.sendRecap) return;
    this.send(`<b>${esc(label)}</b>\n<pre>${esc(recapMd)}</pre>`);
  }

  /** Feed router — matches our own log strings; emoji prefixes only, no re-logging. */
  onFeedEvent(e: FeedEvent): void {
    if (!this.opts.enabled) return;
    const msg = esc(e.message);
    const minted = e.message.match(/^([1-9A-HJ-NP-Za-km-z]{8})…\s*(.*)$/s);
    const body = minted ? `<code>${minted[1]}…</code> ${esc(minted[2])}` : msg;

    switch (e.level) {
      case "pass":
        if (this.opts.sendTokenFinds) this.send(`✅ <b>FILTER</b> ${body}`);
        return;
      case "trade":
        if (this.opts.sendTrades) {
          const icon = e.message.includes("OPENED") ? "🟢" : "🔴";
          this.send(`${icon} <b>TRADE</b> ${body}`);
        }
        return;
      case "reject":
        if (this.opts.sendRejections) this.send(`🚫 <b>REJECT</b> ${body}`);
        return;
      case "warn":
        if (this.opts.sendAlerts) this.send(`⚠️ <b>${esc(e.agent)}</b> ${msg}`);
        return;
      case "error":
        if (this.opts.sendAlerts) this.send(`🚨 <b>${esc(e.agent)}</b> ${msg}`);
        return;
      default:
        return; // info-level (boot chatter, equity lines) stays local
    }
  }

  private split(html: string): string[] {
    if (html.length <= SPLIT_AT) return [html];
    const parts: string[] = [];
    let rest = html;
    while (rest.length > SPLIT_AT) {
      let cut = rest.lastIndexOf("\n", SPLIT_AT);
      if (cut < SPLIT_AT / 2) cut = SPLIT_AT;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) parts.push(rest);
    return parts;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.aborted) {
        const html = this.queue.shift()!;
        const ok = await this.api("sendMessage", {
          chat_id: this.chatId!,
          text: html,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
        if (!ok) logEvent("LOGGER", "warn", "telegram: send failed (will retry next queued msg)");
        await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
      }
    } finally {
      this.pumping = false;
    }
  }

  /** getUpdates long-poll: chat-id capture + command handling. */
  private async pollLoop(): Promise<void> {
    while (!this.aborted) {
      try {
        const res = await fetch(
          `${API}/bot${this.token}/getUpdates?timeout=25&offset=${this.offset}&allowed_updates=["message"]`,
          { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(35_000)]) }
        );
        const data = (await res.json()) as { ok: boolean; result?: Array<{ update_id: number; message?: { text?: string; chat?: { id: number }; from?: { id: number } } }> };
        if (!data.ok || !Array.isArray(data.result)) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        for (const u of data.result) {
          this.offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text) continue;
          void this.handleCommand(msg);
        }
      } catch {
        if (this.aborted) return;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private async handleCommand(msg: { text?: string; chat?: { id: number }; from?: { id: number } }): Promise<void> {
    if (!msg.text) return;
    const senderId = String(msg.from?.id ?? msg.chat?.id ?? "");
    const chatId = String(msg.chat?.id ?? "");
    const known = this.chatId !== null;
    if (known && senderId !== String(this.chatId) && chatId !== String(this.chatId)) return; // admin-only once linked

    const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase().replace("/", "");
    if (cmd === "start") {
      if (!known) {
        this.chatId = chatId || senderId;
        persistChatId(this.chatId);
        logEvent("LOGGER", "info", `telegram: chat linked (${this.chatId}) — alerts live`);
      }
      this.send(
        `<b>✅ CaveMemeDesk linked</b>\n` +
          `Token finds, trades, alerts and the daily recap will arrive here.\n\n` +
          `<code>/status</code> — equity, positions, kill switch\n` +
          `<code>/recap</code> — performance report now\n` +
          `<code>/pause</code> <code>/resume</code> — halt/resume new entries`
      );
      return;
    }
    // Commands require an existing link (prevents rando spam after first /start)
    if (!known || (senderId !== String(this.chatId) && chatId !== String(this.chatId))) return;
    switch (cmd) {
      case "status":
        this.send(`<b>📊 status</b>\n<pre>${esc(this.opts.handlers.status())}</pre>`);
        return;
      case "recap":
        this.sendRecap(this.opts.handlers.recap(), "🌅 recap (requested)");
        return;
      case "pause":
        this.send(`⏸ <b>${esc(this.opts.handlers.pause())}</b>`);
        return;
      case "resume":
        this.send(`▶️ <b>${esc(this.opts.handlers.resume())}</b>`);
        return;
      default:
        this.send(`<code>/status</code> · <code>/recap</code> · <code>/pause</code> · <code>/resume</code>`);
    }
  }

  private async api(method: string, payload: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as { ok?: boolean; description?: string };
      if (!data.ok) {
        logEvent("LOGGER", "warn", `telegram: ${method} rejected — ${data.description ?? "unknown"}`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Best-effort flush + stop the long-poll (used on shutdown). */
  async stop(flushMs = 2500): Promise<void> {
    const deadline = Date.now() + flushMs;
    this.aborted = true;
    this.abort.abort();
    while (this.queue.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    this.offFeed?.();
  }
}
