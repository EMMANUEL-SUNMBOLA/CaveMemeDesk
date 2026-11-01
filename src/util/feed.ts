import type { AgentName, DecisionAction, DecisionRecord, FeedEvent } from "../types.js";
import { insertDecision, insertEvent } from "./db.js";

type Listener = (e: FeedEvent) => void;

const ring: FeedEvent[] = [];
const listeners = new Set<Listener>();
let nextId = 1;
let ringSize = 200;
let echo = true;

const LEVEL_TAGS: Record<FeedEvent["level"], string> = {
  info: "·",
  pass: "+",
  reject: "−",
  trade: "$",
  warn: "!",
  error: "✗",
};

export function configureFeed(opts: { ringSize?: number; echo?: boolean }): void {
  if (opts.ringSize) ringSize = opts.ringSize;
  if (opts.echo !== undefined) echo = opts.echo;
}

export function onFeed(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getFeed(limit = 50): FeedEvent[] {
  return ring.slice(-limit);
}

export function logEvent(agent: AgentName, level: FeedEvent["level"], message: string): FeedEvent {
  const e: FeedEvent = { id: nextId++, ts: Date.now(), agent, level, message };
  ring.push(e);
  if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
  try {
    insertEvent(e);
  } catch {
    /* db unavailable during early boot */
  }
  if (echo) {
    const t = new Date(e.ts).toISOString().slice(11, 19);
    console.log(`${t} [${LEVEL_TAGS[e.level]}] ${e.agent.padEnd(8)} ${message}`);
  }
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      /* listener errors must never crash the desk */
    }
  }
  return e;
}

export function logDecision(
  agent: AgentName,
  action: DecisionAction,
  mint: string | null,
  reason: string,
  metadata?: unknown
): DecisionRecord {
  const d: DecisionRecord = { ts: Date.now(), agent, action, mint, reason, metadata };
  try {
    insertDecision(d);
  } catch {
    /* ignore */
  }
  return d;
}

export function nowIso(ts = Date.now()): string {
  return new Date(ts).toISOString();
}
