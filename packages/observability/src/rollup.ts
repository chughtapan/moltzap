/**
 * Telemetry rollup — reads a telemetry.jsonl file and produces a metrics
 * summary (counts, latency percentiles, rates, idle gaps).
 *
 * Intended to run after a game/session completes. Rollup is a pure function
 * over events so it's trivial to test with fixtures.
 */

import { readFileSync } from "node:fs";
import type { TelemetryEvent } from "./events.js";

export interface Metrics {
  counts: Record<string, number>;
  messagesByConv: Record<string, number>;
  dispatchLatency: {
    p50: number;
    p90: number;
    p99: number;
    max: number;
    count: number;
  };
  idleGapsMs: number[];
  eventSpanMs: number;
}

/** Nearest-rank percentile on a pre-sorted ascending array. Returns 0 if empty. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx]!;
}

const IDLE_GAP_THRESHOLD_MS = 30_000;

export function computeMetrics(events: TelemetryEvent[]): Metrics {
  const counts: Record<string, number> = {};
  const messagesByConv: Record<string, number> = {};
  const dispatchDurations: number[] = [];
  const idleGapsMs: number[] = [];

  let prevTs: number | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const evt of events) {
    counts[evt.event] = (counts[evt.event] ?? 0) + 1;

    if (firstTs === null) firstTs = evt.ts;
    lastTs = evt.ts;

    if (prevTs !== null) {
      const delta = evt.ts - prevTs;
      if (delta > IDLE_GAP_THRESHOLD_MS) idleGapsMs.push(delta);
    }
    prevTs = evt.ts;

    if (evt.event === "message.sent" || evt.event === "message.received") {
      messagesByConv[evt.convId] = (messagesByConv[evt.convId] ?? 0) + 1;
    }

    if (evt.event === "dispatch.complete") {
      dispatchDurations.push(evt.durationMs);
    }
  }

  const sorted = [...dispatchDurations].sort((a, b) => a - b);

  return {
    counts,
    messagesByConv,
    dispatchLatency: {
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      p99: percentile(sorted, 0.99),
      max: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
      count: sorted.length,
    },
    idleGapsMs,
    eventSpanMs: firstTs !== null && lastTs !== null ? lastTs - firstTs : 0,
  };
}

export function rollupFromFile(path: string): Metrics {
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const events: TelemetryEvent[] = lines.map((l) => JSON.parse(l));
  return computeMetrics(events);
}
