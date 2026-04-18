import { describe, it, expect, beforeEach, vi } from "vitest";
import pino from "pino";
import { telemetry } from "../telemetry.js";
import { SCHEMA_VERSION, type TelemetryEvent } from "../events.js";

function sampleEvent(): TelemetryEvent {
  return {
    event: "message.sent",
    source: "server",
    schemaVersion: SCHEMA_VERSION,
    ts: 1_700_000_000_000,
    msgId: "m1",
    convId: "c1",
    senderAgentId: "a1",
    senderKind: "agent",
    bytes: 42,
  };
}

describe("telemetry singleton", () => {
  beforeEach(() => {
    telemetry.reset();
  });

  it("is a no-op before configure()", () => {
    // No logger, no subscribers, no throw
    expect(() => telemetry.emit(sampleEvent())).not.toThrow();
  });

  it("fires pino logger when configured", () => {
    const logLines: unknown[] = [];
    const logger = pino(
      { level: "info" },
      {
        write(chunk: string) {
          logLines.push(JSON.parse(chunk));
        },
      },
    );
    telemetry.configure({ logger, enabled: true });

    telemetry.emit(sampleEvent());

    expect(logLines).toHaveLength(1);
    const line = logLines[0] as { event: string; msgId: string };
    expect(line.event).toBe("message.sent");
    expect(line.msgId).toBe("m1");
  });

  it("fires all subscribers synchronously", () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    telemetry.configure({ enabled: true });
    telemetry.subscribe(a);
    telemetry.subscribe(b);
    telemetry.subscribe(c);

    const evt = sampleEvent();
    telemetry.emit(evt);

    expect(a).toHaveBeenCalledWith(evt);
    expect(b).toHaveBeenCalledWith(evt);
    expect(c).toHaveBeenCalledWith(evt);
  });

  it("subscriber throw does not propagate to caller or block peers", () => {
    const a = vi.fn(() => {
      throw new Error("boom");
    });
    const b = vi.fn();
    telemetry.configure({ enabled: true });
    telemetry.subscribe(a);
    telemetry.subscribe(b);

    expect(() => telemetry.emit(sampleEvent())).not.toThrow();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("pino throw does not propagate and subscribers still fire", () => {
    const badLogger = {
      info: () => {
        throw new Error("bad logger");
      },
    } as unknown as pino.Logger;
    const sub = vi.fn();
    telemetry.configure({ logger: badLogger, enabled: true });
    telemetry.subscribe(sub);

    expect(() => telemetry.emit(sampleEvent())).not.toThrow();
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("enabled:false is a full no-op for both sinks", () => {
    const logLines: unknown[] = [];
    const logger = pino(
      { level: "info" },
      { write: (c: string) => logLines.push(c) },
    );
    const sub = vi.fn();
    telemetry.configure({ logger, enabled: false });
    telemetry.subscribe(sub);

    telemetry.emit(sampleEvent());

    expect(logLines).toHaveLength(0);
    expect(sub).not.toHaveBeenCalled();
  });

  it("unsubscribe removes the handler", () => {
    const a = vi.fn();
    telemetry.configure({ enabled: true });
    const off = telemetry.subscribe(a);
    off();

    telemetry.emit(sampleEvent());

    expect(a).not.toHaveBeenCalled();
  });

  it("reset() clears subscribers and disables the logger", () => {
    const logLines: unknown[] = [];
    const logger = pino(
      { level: "info" },
      { write: (c: string) => logLines.push(c) },
    );
    const sub = vi.fn();
    telemetry.configure({ logger, enabled: true });
    telemetry.subscribe(sub);

    telemetry.reset();
    telemetry.emit(sampleEvent());

    expect(sub).not.toHaveBeenCalled();
    expect(logLines).toHaveLength(0);
  });
});
