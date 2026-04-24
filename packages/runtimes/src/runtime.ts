import { Brand, type Effect } from "effect";
import type { SpawnFailed } from "./errors.js";

// Branded types for Runtime inputs.

export type AgentName = string & Brand.Brand<"AgentName">;
export type ApiKey = string & Brand.Brand<"ApiKey">;
export type ServerUrl = string & Brand.Brand<"ServerUrl">;
export const AgentName = Brand.nominal<AgentName>();
export const ApiKey = Brand.nominal<ApiKey>();
export const ServerUrl = Brand.nominal<ServerUrl>();

export interface WorkspaceFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface RuntimeConnection {
  readonly auth: unknown | null;
}

export interface RuntimeServerHandle {
  readonly connections: {
    getByAgent(agentId: string): ReadonlyArray<RuntimeConnection>;
  };
}

export interface SpawnInput {
  readonly agentName: AgentName;
  readonly apiKey: ApiKey;
  readonly agentId: string;
  readonly serverUrl: ServerUrl;
  readonly workspaceFiles?: ReadonlyArray<WorkspaceFile>;
  readonly modelId?: string;
}

export interface LogSlice {
  /** stdout+stderr bytes starting from the requested offset. */
  readonly text: string;
  /** Byte offset to pass on the next call to continue reading. */
  readonly nextOffset: number;
}

export type ReadyOutcome =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Timeout"; readonly timeoutMs: number }
  | {
      readonly _tag: "ProcessExited";
      readonly exitCode: number | null;
      readonly stderr: string;
    };

/**
 * Runtime interface contract for agent subprocess management.
 *
 * Five methods. spawn starts the subprocess. waitUntilReady blocks until
 * the server's ConnectionManager confirms authentication (or timeout/exit).
 * teardown kills the process group and removes the working directory.
 * getLogs returns accumulated output from a byte offset.
 * getInboundMarker returns a substring that proves an inbound message
 * was received by the runtime's channel plugin.
 */
export interface Runtime {
  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never>;

  /**
   * Blocks until the agent's subprocess has authenticated against the server
   * (confirmed by ConnectionManager entry) or timeout/exit.
   * On Timeout or ProcessExited, the adapter calls teardown internally
   * before returning.
   */
  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never>;

  /** Idempotent. SIGTERM → wait 10s → SIGKILL to process group. rm -rf workdir. */
  teardown(): Effect.Effect<void, never, never>;

  /** Returns stdout+stderr from the given byte offset. */
  getLogs(offset: number): LogSlice;

  /** Substring that proves inbound message delivery when matched against post-send logs. */
  getInboundMarker(): string;
}
