export type SharedContractTelemetryEvent =
  | {
      schemaVersion: 1;
      _tag: "run.started";
      ts: string;
      runId: string;
      scenarioId: string;
      runNumber: number;
      runtime: "openclaw" | "nanoclaw";
      contractMode: "legacy" | "shared";
      modelName: string;
    }
  | {
      schemaVersion: 1;
      _tag: "fleet.started";
      ts: string;
      runtime: "openclaw" | "nanoclaw";
      agentNames: string[];
      serverUrl: string;
    }
  | {
      schemaVersion: 1;
      _tag: "fleet.stopped";
      ts: string;
      runtime: "openclaw" | "nanoclaw";
      agentNames: string[];
    }
  | {
      schemaVersion: 1;
      _tag: "message.sent";
      ts: string;
      scenarioId: string;
      runNumber: number;
      conversationId: string;
      expectedSenderId: string;
      charCount: number;
    }
  | {
      schemaVersion: 1;
      _tag: "message.received";
      ts: string;
      scenarioId: string;
      runNumber: number;
      conversationId: string;
      senderId: string;
      messageId: string;
      charCount: number;
      latencyMs: number;
    }
  | {
      schemaVersion: 1;
      _tag: "run.completed";
      ts: string;
      runId: string;
      scenarioId: string;
      runNumber: number;
      contractMode: "legacy" | "shared";
      status: "success" | "validation_failure" | "runtime_failure" | "aborted";
    };

type TelemetryHandler = (event: SharedContractTelemetryEvent) => void;

const handlers = new Set<TelemetryHandler>();

function safeEmitToHandlers(event: SharedContractTelemetryEvent): void {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (err) {
      void err;
      // #ignore-sloppy-code[bare-catch]: telemetry is fail-open; subscriber failures are intentionally dropped
      // Telemetry is fail-open. A bad subscriber must not affect eval runs.
    }
  }
}

export const telemetry = {
  emit(event: SharedContractTelemetryEvent): void {
    safeEmitToHandlers(event);
  },
  subscribe(handler: TelemetryHandler): () => void {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  },
  reset(): void {
    handlers.clear();
  },
};
