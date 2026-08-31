/**
 * Usage Limit Detector — classifies API errors as usage-limit-related
 * and triggers the global pause mechanism when detected.
 *
 * Usage-limit errors indicate systemic conditions (rate limits, quota exceeded,
 * billing issues, overloaded APIs) where continued retrying across multiple
 * agents is wasteful. Transient server errors (500, timeout, connection refused)
 * are NOT classified as usage-limit errors — they are temporary and may resolve
 * on their own via per-session retry.
 */

import type { TaskStore } from "@kb/core";
import { createLogger } from "./logger.js";

const log = createLogger("usage-limit");

/**
 * Patterns that indicate API usage/capacity/billing limits.
 * These are checked case-insensitively against error messages.
 */
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /overloaded/i,
  /rate[_\s]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b529\b/,
  /quota/i,
  /billing/i,
  /\bcredit/i,
  /insufficient/i,
];

/**
 * Classify whether an error message indicates a usage-limit condition.
 *
 * Returns `true` for rate limits, overloaded errors, quota/billing issues —
 * conditions where all agents should stop. Returns `false` for transient
 * server errors (500/502/503/504, timeout, connection refused) that may
 * resolve on their own.
 */
export function isUsageLimitError(errorMessage: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Lightweight coordinator that agents call when they detect usage-limit errors.
 * Triggers the global pause mechanism by calling `store.updateSettings({ globalPause: true })`.
 *
 * **Idempotency:** Tracks an internal `paused` flag so that multiple concurrent
 * agents hitting limits only trigger one pause. The flag resets when `globalPause`
 * is externally set back to `false` (detected by reading settings before pausing).
 */
/**
 * Check if an agent session resolved with an error after exhausting retries.
 *
 * pi-coding-agent's `session.prompt()` does **not** always throw when retries
 * are exhausted. In pi 0.84 the failure is exposed as `state.errorMessage`
 * and on the final assistant message (`stopReason: "error"`). Re-raise it so
 * existing error handling can detect usage limits and fail the task correctly.
 *
 * The legacy `state.error` field remains supported for restored/mock sessions.
 */
export function checkSessionError(session: {
  state: {
    errorMessage?: string;
    error?: string;
    messages?: Array<{
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    }>;
  };
}): void {
  const state = session.state;
  const directError = state?.errorMessage ?? state?.error;
  if (directError) {
    throw new Error(directError);
  }

  const lastAssistantMessage = state?.messages
    ?.slice()
    .reverse()
    .find((message) => message.role === "assistant");
  if (lastAssistantMessage?.stopReason === "error") {
    throw new Error(lastAssistantMessage.errorMessage ?? "Agent stopped with an error");
  }
}

export class UsageLimitPauser {
  private paused = false;

  constructor(private store: TaskStore) {}

  /**
   * Called by agents when a usage-limit error is detected after retries are exhausted.
   * Triggers global pause if not already paused.
   *
   * @param agentType - The type of agent that hit the limit (e.g., "executor", "triage", "merger")
   * @param taskId - The task that was being processed when the limit was hit
   * @param errorMessage - The error message from the API
   */
  async onUsageLimitHit(agentType: string, taskId: string, errorMessage: string): Promise<void> {
    // If we already triggered a pause, check if it was externally reset
    if (this.paused) {
      const settings = await this.store.getSettings();
      if (settings.globalPause) {
        // Still paused — no need to trigger again
        return;
      }
      // External reset detected — allow re-triggering
      this.paused = false;
    }

    this.paused = true;

    log.warn(`${agentType} hit usage limit on ${taskId}: ${errorMessage}`);

    // Log the triggering error on the task
    await this.store.logEntry(
      taskId,
      `Usage limit detected (${agentType}): ${errorMessage}`,
    );

    // Activate global pause
    await this.store.updateSettings({ globalPause: true });

    log.warn("⚠ Global pause activated — all automated activity will halt");
  }
}
