import type { AgentName, DecisionAction, FeedEvent } from "../types.js";
import { logDecision, logEvent } from "../util/feed.js";

export const LOGGER = {
  event(agent: AgentName, level: FeedEvent["level"], message: string): void {
    logEvent(agent, level, message);
  },
  decision(agent: AgentName, action: DecisionAction, mint: string | null, reason: string, metadata?: unknown): void {
    logDecision(agent, action, mint, reason, metadata);
  },
  /** Rejection = decision + feed event (always paired so the UI and DB agree). */
  reject(agent: AgentName, mint: string, reason: string, metadata?: unknown): void {
    logDecision(agent, "rejected", mint, reason, metadata);
    logEvent(agent, "reject", `${mint.slice(0, 8)}… rejected: ${reason}`);
  },
  pass(agent: AgentName, mint: string, reason: string, metadata?: unknown): void {
    logDecision(agent, "filtered", mint, reason, metadata);
    logEvent(agent, "pass", `${mint.slice(0, 8)}… ${reason}`);
  },
  trade(action: "trade-opened" | "trade-closed", mint: string, reason: string, metadata?: unknown): void {
    logDecision("EXECUTOR", action, mint, reason, metadata);
    logEvent("EXECUTOR", "trade", `${mint.slice(0, 8)}… ${reason}`);
  },
};
