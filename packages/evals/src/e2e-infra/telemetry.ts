export type SharedContractTelemetryEvent =
  | {
      schemaVersion: 1;
      _tag: "run.started";
      ts: string;
      runId: string;
      scenarioId: string;
      runNumber: number;
      runtime: "openclaw" | "nanoclaw";
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
      status: "success" | "validation_failure" | "runtime_failure" | "aborted";
    };

export type RunStartedTelemetryEvent = Extract<
  SharedContractTelemetryEvent,
  { _tag: "run.started" }
>;
export type FleetStartedTelemetryEvent = Extract<
  SharedContractTelemetryEvent,
  { _tag: "fleet.started" }
>;
export type FleetStoppedTelemetryEvent = Extract<
  SharedContractTelemetryEvent,
  { _tag: "fleet.stopped" }
>;
export type MessageSentTelemetryEvent = Extract<
  SharedContractTelemetryEvent,
  { _tag: "message.sent" }
>;
export type MessageReceivedTelemetryEvent = Extract<
  SharedContractTelemetryEvent,
  { _tag: "message.received" }
>;
export type RunCompletedTelemetryEvent = Extract<
  SharedContractTelemetryEvent,
  { _tag: "run.completed" }
>;

export function createRunStartedTelemetryEvent(
  event: Omit<RunStartedTelemetryEvent, "schemaVersion" | "_tag">,
): RunStartedTelemetryEvent {
  return {
    schemaVersion: 1,
    _tag: "run.started",
    ...event,
  };
}

export function createFleetStartedTelemetryEvent(
  event: Omit<FleetStartedTelemetryEvent, "schemaVersion" | "_tag">,
): FleetStartedTelemetryEvent {
  return {
    schemaVersion: 1,
    _tag: "fleet.started",
    ...event,
  };
}

export function createFleetStoppedTelemetryEvent(
  event: Omit<FleetStoppedTelemetryEvent, "schemaVersion" | "_tag">,
): FleetStoppedTelemetryEvent {
  return {
    schemaVersion: 1,
    _tag: "fleet.stopped",
    ...event,
  };
}

export function createMessageSentTelemetryEvent(
  event: Omit<MessageSentTelemetryEvent, "schemaVersion" | "_tag">,
): MessageSentTelemetryEvent {
  return {
    schemaVersion: 1,
    _tag: "message.sent",
    ...event,
  };
}

export function createMessageReceivedTelemetryEvent(
  event: Omit<MessageReceivedTelemetryEvent, "schemaVersion" | "_tag">,
): MessageReceivedTelemetryEvent {
  return {
    schemaVersion: 1,
    _tag: "message.received",
    ...event,
  };
}

export function createRunCompletedTelemetryEvent(
  event: Omit<RunCompletedTelemetryEvent, "schemaVersion" | "_tag">,
): RunCompletedTelemetryEvent {
  return {
    schemaVersion: 1,
    _tag: "run.completed",
    ...event,
  };
}

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
