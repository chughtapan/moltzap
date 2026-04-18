import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { telemetry } from "../telemetry.js";
import { TelemetryCollector } from "../collector.js";
import { SCHEMA_VERSION, type TelemetryEvent } from "../events.js";

function fakeEvent(i: number): TelemetryEvent {
  return {
    event: "message.sent",
    source: "server",
    schemaVersion: SCHEMA_VERSION,
    ts: 1_700_000_000_000 + i,
    msgId: `m${i}`,
    convId: "c1",
    senderAgentId: "a1",
    senderKind: "agent",
    bytes: 10,
  };
}

describe("TelemetryCollector", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    telemetry.reset();
    dir = mkdtempSync(join(tmpdir(), "collector-test-"));
    path = join(dir, "telemetry.jsonl");
  });

  afterEach(() => {
    telemetry.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes one JSON line per event in arrival order", async () => {
    telemetry.configure({ enabled: true });
    const c = new TelemetryCollector(path);
    c.start();

    telemetry.emit(fakeEvent(1));
    telemetry.emit(fakeEvent(2));
    telemetry.emit(fakeEvent(3));

    await c.stop();

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).msgId).toBe("m1");
    expect(JSON.parse(lines[1]!).msgId).toBe("m2");
    expect(JSON.parse(lines[2]!).msgId).toBe("m3");
  });

  it("flushes and closes the file on stop()", async () => {
    telemetry.configure({ enabled: true });
    const c = new TelemetryCollector(path);
    c.start();
    telemetry.emit(fakeEvent(1));
    await c.stop();

    // After stop, further emits should NOT appear in the file.
    telemetry.emit(fakeEvent(2));
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("writes no partial lines (every line is complete JSON)", async () => {
    telemetry.configure({ enabled: true });
    const c = new TelemetryCollector(path);
    c.start();

    for (let i = 0; i < 100; i++) telemetry.emit(fakeEvent(i));
    await c.stop();

    const raw = readFileSync(path, "utf-8");
    // Trailing newline is acceptable; no partial JSON.
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(100);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("exposes captured events only when keepInMemory is true", async () => {
    telemetry.configure({ enabled: true });
    const c = new TelemetryCollector(path, { keepInMemory: true });
    c.start();
    telemetry.emit(fakeEvent(1));
    telemetry.emit(fakeEvent(2));

    expect(c.events).toHaveLength(2);
    expect(c.events![0]!.event).toBe("message.sent");
    await c.stop();
  });

  it("does not retain events in memory by default", async () => {
    telemetry.configure({ enabled: true });
    const c = new TelemetryCollector(path);
    c.start();
    telemetry.emit(fakeEvent(1));
    expect(c.events).toBeNull();
    await c.stop();
  });
});
