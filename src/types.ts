export type AgentName = "SCOUT" | "FILTER" | "ANALYST" | "EXECUTOR" | "RISK" | "LOGGER";

export type CandidateSource = "pumpportal-create" | "pumpportal-migration" | "raydium-init";

export interface Candidate {
  mint: string;
  name?: string;
  symbol?: string;
  dev?: string;
  pool?: string;
  source: CandidateSource;
  ts: number;
}

export interface DexPairInfo {
  pairAddress: string;
  dexId: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volumeH24Usd: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  pairCreatedAt: number | null;
}

export interface SecurityReport {
  mint: string;
  symbol?: string;
  name?: string;
  dev: string | null;
  priceUsd: number;
  liquidityUsd: number;
  volumeH24Usd: number | null;
  hourlyVolumeUsd: number;
  buyCountH1: number | null;
  sellCountH1: number | null;
  pairCreatedAt: number;
  pool: string;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpLockedPct: number;
  top10Pct: number;
  devRugCheck: "clean";
  devPriorTokens: number | null;
  notes: string[];
}

export type FilterVerdict =
  | { ok: true; report: SecurityReport }
  | { ok: false; reason: string };

export interface ScoreBreakdown {
  volumeMomentum: number;
  buySellRatio: number;
  holderDistribution: number;
  liquidityDepth: number;
  devHistory: number;
  ageSweetSpot: number;
  metadataHeuristics: number;
}

export interface ScoreResult {
  score: number;
  breakdown: ScoreBreakdown;
}

export interface Position {
  mint: string;
  symbol?: string;
  tokens: number;
  costUsd: number;
  entryPriceUsd: number;
  entryTs: number;
  peakPriceUsd: number;
  trailingActive: boolean;
  stopPriceUsd: number;
  openReason: string;
}

export interface ClosedTrade {
  mint: string;
  symbol?: string;
  openedTs: number;
  closedTs: number;
  costUsd: number;
  proceedsUsd: number;
  pnlUsd: number;
  pnlPct: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  holdSeconds: number;
  openReason: string;
  closeReason: string;
}

export interface EquitySnapshot {
  ts: number;
  cashUsd: number;
  equityUsd: number;
  openPositions: number;
}

export type DecisionAction =
  | "scouted"
  | "rejected"
  | "filtered"
  | "scored"
  | "trade-opened"
  | "trade-closed"
  | "halted"
  | "paused"
  | "system";

export interface DecisionRecord {
  ts: number;
  agent: AgentName;
  action: DecisionAction;
  mint: string | null;
  reason: string;
  metadata?: unknown;
}

export interface FeedEvent {
  id: number;
  ts: number;
  agent: AgentName;
  level: "info" | "pass" | "reject" | "trade" | "warn" | "error";
  message: string;
}

export interface DeskRuntimeState {
  mode: "paper" | "live";
  paused: boolean;
  killSwitchActive: boolean;
  cooldownUntil: number | null;
  balanceUsd: number;
  cashUsd: number;
  equityUsd: number;
  solUsd: number;
  dayPnlUsd: number;
  dayPnlPct: number;
  positions: Position[];
  marks: Map<string, number>;
  equityCurve: EquitySnapshot[];
  recentTrades: ClosedTrade[];
  startedAt: number;
  candidatesSeen: number;
  candidatesRejected: number;
  tradesOpened: number;
  tradesClosed: number;
}
