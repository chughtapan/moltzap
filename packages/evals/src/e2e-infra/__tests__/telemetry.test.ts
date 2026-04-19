import { afterEach, describe, expect, it } from "vitest";
import {
  createFleetStartedTelemetryEvent,
  createRunStartedTelemetryEvent,
  telemetry,
  type SharedContractTelemetryEvent,
} from "../telemetry.js";

afterEach(() => {
  telemetry.reset();
});

describe("telemetry", () => {
  it("delivers events to subscribers", () => {
    const received: SharedContractTelemetryEvent[] = [];
    const unsubscribe = telemetry.subscribe((event) => {
      received.push(event);
    });

    telemetry.emit(
      createRunStartedTelemetryEvent({
        ts: "2026-04-19T00:00:00.000Z",
        runId: "run-1",
        scenarioId: "EVAL-001",
        runNumber: 1,
        runtime: "openclaw",
        contractMode: "shared",
        modelName: "test-model",
      }),
    );

    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]?._tag).toBe("run.started");
  });

  it("swallows subscriber failures and keeps notifying later subscribers", () => {
    const received: SharedContractTelemetryEvent[] = [];
    telemetry.subscribe(() => {
      throw new Error("boom");
    });
    telemetry.subscribe((event) => {
      received.push(event);
    });

    telemetry.emit(
      createFleetStartedTelemetryEvent({
        ts: "2026-04-19T00:00:00.000Z",
        runtime: "openclaw",
        agentNames: ["eval-agent"],
        serverUrl: "ws://example.test",
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?._tag).toBe("fleet.started");
  });
});
