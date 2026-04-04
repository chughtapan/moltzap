/**
 * Two-tier rate limiter mirroring OpenClaw's rateLimiter.ts pattern.
 *
 * Tier 1: Proactive RPM/TPM tracking with 65-second sliding window.
 * Tier 2: Reactive 429 circuit breaker with retry-after parsing.
 */

import type { ModelConfig } from "./model-config.js";
import { logger } from "./logger.js";

interface UsageRecord {
  timestamp: number;
  tokensUsed: number;
  isRequest: boolean;
}

interface ModelRateLimitState {
  usageRecords: UsageRecord[];
}

export class RateLimiter {
  private modelStates = new Map<string, ModelRateLimitState>();
  private modelPauses = new Map<string, number>();
  private _waitingCount = 0;

  get waitingCount(): number {
    return this._waitingCount;
  }

  private getModelState(modelId: string): ModelRateLimitState {
    let state = this.modelStates.get(modelId);
    if (!state) {
      state = { usageRecords: [] };
      this.modelStates.set(modelId, state);
    }
    return state;
  }

  private cleanUpRecords(state: ModelRateLimitState): void {
    const cutoff = Date.now() - 65_000;
    state.usageRecords = state.usageRecords.filter((r) => r.timestamp > cutoff);
  }

  reportError(model: ModelConfig, error: unknown): void {
    const err = error as {
      status?: string;
      code?: number;
      message?: string;
      originalMessage?: string;
    };

    const isResourceExhausted =
      err?.status === "RESOURCE_EXHAUSTED" ||
      err?.code === 429 ||
      (err?.message && err.message.includes("429"));

    if (!isResourceExhausted) return;

    const message = err.originalMessage || err.message || "";
    const match = message.match(/retry in ([0-9.]+)\s*s/i);
    let retrySeconds = 60;
    if (match?.[1]) {
      retrySeconds = parseFloat(match[1]);
    }

    const pauseDuration = Math.ceil(retrySeconds * 1000) + 1000;
    const pausedUntil = Date.now() + pauseDuration;
    this.modelPauses.set(model.modelId, pausedUntil);

    logger.debug(
      `RateLimiter: Pausing ${model.modelId} for ${pauseDuration}ms due to 429. Resumes at ${new Date(pausedUntil).toISOString()}`,
    );
  }

  async acquirePermit(
    model: ModelConfig,
    estimatedTokens: number,
  ): Promise<void> {
    this._waitingCount++;
    try {
      const { modelId, requestsPerMinute, tokensPerMinute } = model;
      if (!requestsPerMinute && !tokensPerMinute) return;

      const state = this.getModelState(modelId);

      while (true) {
        // Tier 2: Check circuit breaker
        const pausedUntil = this.modelPauses.get(modelId);
        if (pausedUntil && pausedUntil > Date.now()) {
          const pauseWait = pausedUntil - Date.now();
          logger.debug(
            `Rate limiting ${modelId}: Circuit breaker pause ${pauseWait}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, pauseWait));
          continue;
        }

        // Tier 1: Proactive RPM/TPM tracking
        this.cleanUpRecords(state);

        let currentTokens = 0;
        let currentRequests = 0;
        for (const r of state.usageRecords) {
          currentTokens += r.tokensUsed;
          if (r.isRequest) currentRequests++;
        }

        let rpmWait = 0;
        let tpmWait = 0;

        // Check RPM
        if (requestsPerMinute && currentRequests + 1 > requestsPerMinute) {
          const oldestRequest = state.usageRecords.find((r) => r.isRequest);
          if (oldestRequest) {
            rpmWait = Math.max(
              0,
              oldestRequest.timestamp + 60_000 - Date.now(),
            );
          }
        }

        // Check TPM with 10% safety buffer
        if (tokensPerMinute) {
          const effectiveLimit = Math.floor(tokensPerMinute * 0.9);
          if (currentTokens + estimatedTokens > effectiveLimit) {
            let tokensToShed = currentTokens + estimatedTokens - effectiveLimit;
            let cumulative = 0;
            for (const record of state.usageRecords) {
              cumulative += record.tokensUsed;
              if (cumulative >= tokensToShed) {
                tpmWait = Math.max(
                  tpmWait,
                  record.timestamp + 60_000 - Date.now(),
                );
                break;
              }
            }
          }
        }

        const requiredWait = Math.max(rpmWait, tpmWait);
        if (requiredWait <= 0) {
          // Reserve the permit to prevent race conditions
          state.usageRecords.push({
            timestamp: Date.now(),
            tokensUsed: estimatedTokens,
            isRequest: true,
          });
          break;
        }

        logger.debug(
          `Rate limiting ${modelId}: Waiting ${requiredWait}ms (RPM: ${rpmWait}ms, TPM: ${tpmWait}ms)`,
        );
        await new Promise((resolve) => setTimeout(resolve, requiredWait));
      }
    } finally {
      this._waitingCount--;
    }
  }

  recordUsage(model: ModelConfig, actualTokens: number): void {
    if (actualTokens <= 0) return;
    const state = this.getModelState(model.modelId);
    state.usageRecords.push({
      timestamp: Date.now(),
      tokensUsed: actualTokens,
      isRequest: false,
    });
  }
}

export const rateLimiter = new RateLimiter();
