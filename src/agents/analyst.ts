import type { ScoreResult, SecurityReport } from "../types.js";
import type { DeskConfig } from "../config.js";
import { computeScore } from "../core/scoring.js";

/** ANALYST — deterministic weighted score. Passes score >= minScore only. */
export class AnalystAgent {
  constructor(private cfg: DeskConfig) {}

  score(report: SecurityReport, now = Date.now()): ScoreResult {
    return computeScore(report, this.cfg.analyst.weights, now);
  }

  shouldTrade(result: ScoreResult): boolean {
    return result.score >= this.cfg.analyst.minScore;
  }
}
