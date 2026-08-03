import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { Effect } from "effect";

/** Represents core test ready outcome values. */
export type CoreTestReadyOutcome =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Timeout"; readonly timeoutMs: number }
  | {
      readonly _tag: "ProcessExited";
      readonly exitCode: number | null;
      readonly stderr: string;
    };

/** Process capabilities needed by in-process runtime tests. */
export interface CoreTestRuntimeServerHandle {
  awaitAgentReady(
    agentId: AgentId,
    timeoutMs: number,
  ): Effect.Effect<CoreTestReadyOutcome>;
}

/** Database operations available to consumers of the published test harness. */
export interface CoreTestDatabasePort {
  execute(sql: string): PromiseLike<unknown>;
  reset(): PromiseLike<undefined>;
}

/** Stable projection of a finished server trace span. */
export interface CoreTestSpan {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** Trace-capture operations available to test-harness consumers. */
export interface CoreTestSpanExporterPort {
  getFinishedSpans(): readonly CoreTestSpan[];
  reset(): void;
}

/** Published server handle composed only from server-owned test ports. */
export interface CoreTestServerPort {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly db: CoreTestDatabasePort;
  readonly runtimeServer: CoreTestRuntimeServerHandle;
  readonly spanExporter: CoreTestSpanExporterPort | null;
}

/** Configures start core test server. */
export interface StartCoreTestServerOptions {
  readonly pgHost?: string;
  readonly pgPort?: number;
  readonly registrationSecret?: string;
  readonly adminUserId?: UserId;
}
