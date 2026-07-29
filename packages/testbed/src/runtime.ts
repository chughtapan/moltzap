import { Brand, type Effect } from "effect";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import { serverBaseUrl, type ServerBaseUrl } from "@moltzap/protocol/network";
import type { SpawnFailed } from "./errors.js";

// Branded types for Runtime inputs.

export type AgentName = string & Brand.Brand<"AgentName">;
const AgentNameBrand = Brand.nominal<AgentName>();

export const AgentName = (value: string): AgentName => AgentNameBrand(value);

/**
 * The address an adapter hands its child process: the protocol's path-free
 * base, under this package's long-standing name. The child's client appends
 * the socket route itself, so a value carrying one dials `/ws/ws` and never
 * authenticates. Accepts either form a caller is likely to hold — the base
 * URL or the socket endpoint — and throws on any other path.
 */
export type ServerUrl = ServerBaseUrl;
export const ServerUrl = serverBaseUrl;

export interface WorkspaceFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface RuntimeServerHandle {
  /**
   * Resolves to `Ready` when the named agent has authenticated against the
   * server. Resolves to `Timeout` after `timeoutMs` if no authenticated
   * connection ever appears. Resolves to `ProcessExited` only if the
   * implementation can detect that the agent's owning process exited before
   * authenticating; otherwise `Timeout` covers that case (the runtime
   * adapters layer their own exit-detection on top via `Effect.race`).
   *
   * In-process implementations wire this through `awaitAgentReadyByPolling`.
   * Out-of-process implementations (e.g., a zapbot orchestrator talking to
   * a standalone moltzap-server) implement it directly, typically via a
   * presence-event subscription on the server's WebSocket API.
   */
  awaitAgentReady(
    agentId: AgentId,
    timeoutMs: number,
  ): Effect.Effect<ReadyOutcome, never, never>;
}

export interface SpawnInput {
  readonly agentName: AgentName;
  readonly apiKey: AgentKey;
  readonly agentId: AgentId;
  readonly serverUrl: ServerBaseUrl;
  readonly workspaceFiles?: ReadonlyArray<WorkspaceFile>;
  readonly modelId?: string;
}

export interface LogSlice {
  /**
   * stdout+stderr from the requested offset. Adapters retain a bounded
   * window (startup head + rolling tail); when the offset falls into a
   * dropped region, the missing middle is replaced by a
   * `[... log window elided ...]` marker, so a stale cursor can observe
   * non-contiguous text and marker-matching consumers must poll faster
   * than the tail window fills.
   */
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

  /** Idempotently stops the spawned runtime and removes its isolated state. */
  teardown(): Effect.Effect<void, never, never>;

  /** Returns stdout+stderr from the given byte offset. */
  getLogs(offset: number): LogSlice;

  /** Substring that proves inbound message delivery when matched against post-send logs. */
  getInboundMarker(): string;
}
