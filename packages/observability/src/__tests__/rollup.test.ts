import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeMetrics, rollupFromFile } from "../rollup.js";
import { SCHEMA_VERSION, type TelemetryEvent } from "../events.js";

function msgSent(msgId: string, ts: number, convId = "c1"): TelemetryEvent {
  return {
    event: "message.sent",
    source: "server",
    schemaVersion: SCHEMA_VERSION,
    ts,
    msgId,
    convId,
    senderAgentId: "a1",
    senderKind: "agent",
    bytes: 10,
  };
}

function dispatchComplete(
  msgId: string,
  ts: number,
  durationMs: number,
): TelemetryEvent {
  return {
    event: "dispatch.complete",
    source: "agent",
    schemaVersion: SCHEMA_VERSION,
    ts,
    msgId,
    convId: "c1",
    agentId: "a1",
    durationMs,
    outcome: "final",
  };
}

describe("computeMetrics", () => {
  it("counts events by name", () => {
    const events = [msgSent("m1", 1), msgSent("m2", 2), msgSent("m3", 3)];
    const m = computeMetrics(events);
    expect(m.counts["message.sent"]).toBe(3);
  });

  it("computes p50/p90/p99 of dispatch.complete.durationMs", () => {
    const events: TelemetryEvent[] = [];
    // Durations 1..100ms. p50=50, p90=90, p99=99.
    for (let i = 1; i <= 100; i++) {
      events.push(dispatchComplete(`m${i}`, 1000 + i, i));
    }
    const m = computeMetrics(events);
    // Nearest-rank: p50 of 100 sorted vals → index ceil(0.5*100)-1 = 49 → value 50
    expect(m.dispatchLatency.p50).toBe(50);
    expect(m.dispatchLatency.p90).toBe(90);
    expect(m.dispatchLatency.p99).toBe(99);
  });

  it("finds idle gaps > 30s between events", () => {
    const events = [
      msgSent("m1", 1_000_000),
      msgSent("m2", 1_005_000), // 5s gap, not a gap
      msgSent("m3", 1_050_000), // 45s gap - should show up
      msgSent("m4", 1_055_000),
    ];
    const m = computeMetrics(events);
    expect(m.idleGapsMs).toEqual([45_000]);
  });

  it("groups message counts by conversation", () => {
    const events = [
      msgSent("m1", 1, "c1"),
      msgSent("m2", 2, "c1"),
      msgSent("m3", 3, "c2"),
    ];
    const m = computeMetrics(events);
    expect(m.messagesByConv["c1"]).toBe(2);
    expect(m.messagesByConv["c2"]).toBe(1);
  });

  it("handles empty event stream without crashing", () => {
    const m = computeMetrics([]);
    expect(m.counts).toEqual({});
    expect(m.dispatchLatency.p50).toBe(0);
    expect(m.idleGapsMs).toEqual([]);
  });
});

describe("rollupFromFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rollup-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads JSONL from disk and produces metrics.json", () => {
    const path = join(dir, "telemetry.jsonl");
    const events = [msgSent("m1", 1), msgSent("m2", 2)];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const m = rollupFromFile(path);
    expect(m.counts["message.sent"]).toBe(2);
  });
});
