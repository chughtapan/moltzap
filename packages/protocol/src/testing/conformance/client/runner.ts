/**
 * Client-side conformance runner — acquires a TestServer substrate plus the
 * consumer-provided real-client factory under a single Scope, pinned to an
 * FC seed.
 *
 * Parallel to `conformance/runner.ts` (server-side: real server + TestClient).
 * This module's input is `realClient: () => Effect<RealClientHandle, E,
 * Scope>`; scope teardown closes the real client, drains the handshake-noise
 * guard (see `ClientHandshakeWindow` below), and releases the TestServer.
 *
 * Architect O5 decision: the factory returns an `Effect` that owns the real
 * client's lifetime via `Scope`. Consumers that already ship an Effect-native
 * construction path (`packages/client/MoltZapWsClient` via its internal
 * `ManagedRuntime`) wrap it in `Effect.acquireRelease`. Channel packages
 * (`openclaw-channel`, `nanoclaw-channel`) add a narrow test-support subpath
 * export (see §4 O5 resolution in the design doc) that returns the same
 * factory shape.
 */
import { Context, type Effect, type Ref, type Scope } from "effect";
import type { EventFrame, ResponseFrame } from "../../../schema/frames.js";
import type { TestServer, TestServerConnection } from "../../test-server.js";
import type { ToxiproxyClient } from "../../toxics/client.js";
import type {
  RealServerAcquireError,
  ToxicControlError,
} from "../../errors.js";
import type { ConformanceArtifact } from "../runner.js";

/**
 * Opaque handle to a live real MoltZap client connected to `TestServer`.
 * The consumer's factory returns this under a `Scope`; scope release runs
 * `close()`.
 *
 * Invariant I9: every field below is a **public** observable surface on
 * the real client — no private reads, no monkey-patching, no log
 * scraping. When a channel package's client is private, the consumer
 * exposes it via a test-support subpath export (O5 resolution).
 */
export interface RealClientHandle {
  /**
   * Stable identifier emitted in the connect frame's `agentId` field.
   * Used to correlate TestServer-observed inbound frames to this client.
   */
  readonly agentId: string;
  /**
   * Fully-connected promise — resolves after the handshake completes and
   * the client is ready to receive events. Property bodies await this
   * before scripting TestServer emissions so the handshake-noise guard
   * window is closed (see `ClientHandshakeWindow`).
   */
  readonly ready: Effect.Effect<void, RealClientLifecycleError>;
  /**
   * Real client's public event-subscriber surface. Every captured event
   * is tagged with the property-authored `emissionId` when the property
   * uses `ClientHandshakeWindow.emitTaggedEvent`; predicates filter by
   * that tag to exclude handshake-noise frames.
   */
  readonly events: RealClientEventSubscriber;
  /**
   * Real client's documented RPC caller. B1 / B4 / D5 predicates invoke
   * this and assert on the returned promise's resolution / rejection.
   */
  readonly call: RealClientRpcCaller;
  /**
   * Real client's documented close / disconnect lifecycle signal. D6
   * predicate awaits this on slow-close and asserts it resolves within
   * the reap deadline.
   */
  readonly closeSignal: Effect.Effect<RealClientCloseEvent>;
  /**
   * Scope-release hook. The runner's Scope calls this on teardown; a
   * close that throws surfaces as `RealClientLifecycleError`.
   */
  readonly close: Effect.Effect<void, RealClientLifecycleError>;
}

/**
 * Real client's public event-subscriber surface. Property bodies `subscribe`
 * once per fixture and drain via `snapshot`. Concrete shape is per-consumer
 * (packages/client's `waitForEvent` + `onEvent`, channel packages' native
 * event pipe); the wrapper adapts it to this interface.
 */
export interface RealClientEventSubscriber {
  readonly subscribe: (
    filter: RealClientEventFilter,
  ) => Effect.Effect<RealClientSubscription, RealClientLifecycleError>;
  readonly snapshot: Effect.Effect<ReadonlyArray<ObservedEvent>>;
}

export interface RealClientSubscription {
  readonly id: string;
  readonly unsubscribe: Effect.Effect<void>;
}

export interface RealClientEventFilter {
  /**
   * Property-authored emission tag. The real client surfaces only
   * events whose payload carries this tag, excluding handshake-noise.
   * Implementations match on the event payload's `__emissionId` field
   * (set by `ClientHandshakeWindow.emitTaggedEvent`).
   */
  readonly emissionTag?: string;
  /** Restrict to a specific conversation / task. */
  readonly conversationId?: string;
  /** Restrict to a specific event-name family. */
  readonly eventNamePrefix?: string;
}

/**
 * Observed event after the real client has surfaced it on its public
 * subscriber API. `rawBytes` carries the payload byte-for-byte (C3);
 * `decoded` is the schema-decoded frame (A2 validation target).
 */
export interface ObservedEvent {
  readonly emissionTag: string | null;
  readonly decoded: EventFrame;
  readonly rawBytes: Uint8Array;
  readonly observedAtMs: number;
}

/**
 * Real client's RPC caller. Takes the raw JSON-RPC method + params;
 * returns the decoded response or a typed error. Contract: the real
 * client itself generates request IDs — the property does not mint
 * them — and records the outbound ID via `outboundIdFeed` so the
 * property can assert ID-set equality (B4, O7 idempotence).
 */
export interface RealClientRpcCaller {
  readonly call: (
    method: string,
    params: unknown,
  ) => Effect.Effect<ResponseFrame, RealClientRpcError>;
  /** Stream of outbound request IDs the real client has minted. */
  readonly outboundIdFeed: Effect.Effect<ReadonlyArray<string>>;
}

/**
 * Real-client lifecycle error tag. All three cover the Principle 3 error
 * channel; no raw throws escape the factory's Scope.
 */
export class RealClientLifecycleError {
  readonly _tag = "RealClientLifecycleError";
  constructor(readonly cause: unknown) {}
}

/** Typed error surface for real-client RPC calls (D5 predicate target). */
export class RealClientRpcError {
  readonly _tag = "RealClientRpcError";
  constructor(
    readonly kind:
      | "timeout"
      | "server-error"
      | "malformed-response"
      | "disconnected",
    readonly method: string,
    readonly documentedErrorTag: string | null,
    readonly cause: unknown,
  ) {}
}

/** Close-event shape surfaced by `RealClientHandle.closeSignal`. */
export interface RealClientCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly observedAtMs: number;
}

/**
 * Handshake-noise guard window (O7 resolution).
 *
 * When a real client connects to TestServer, `packages/client` and the
 * channel packages emit hello + subscribe + presence frames **before**
 * the property's first scripted emission. Those frames must not be
 * accepted as satisfying a later sampled predicate.
 *
 * Every client-side property that observes frames requests a
 * `ClientHandshakeWindow` on its fixture and emits via
 * `emitTaggedEvent` / `emitTaggedResponse`. The window stamps each
 * emission with a property-authored `emissionTag`; the
 * `RealClientEventSubscriber` filter drops untagged events.
 *
 * D6 is the only client-side property exempt (observes lifecycle
 * signals, not frames).
 */
export interface ClientHandshakeWindow {
  readonly freshEmissionTag: Effect.Effect<string>;
  readonly emitTaggedEvent: (opts: {
    readonly connection: TestServerConnection;
    readonly base: EventFrame;
    readonly emissionTag: string;
  }) => Effect.Effect<string>;
  readonly emitTaggedResponse: (opts: {
    readonly connection: TestServerConnection;
    readonly base: ResponseFrame;
    readonly emissionTag: string;
  }) => Effect.Effect<string>;
  readonly awaitHandshakeComplete: Effect.Effect<
    void,
    RealClientLifecycleError
  >;
}

export const ClientHandshakeWindow = Context.GenericTag<ClientHandshakeWindow>(
  "@moltzap/protocol/testing/ClientHandshakeWindow",
);

/**
 * Context a client-side property receives. Parallel to server-side
 * `ConformanceRunContext` — same `seed`, `toxiproxy`, `artifacts`
 * plumbing; different factory pair.
 */
export interface ClientConformanceRunContext {
  readonly testServer: TestServer;
  readonly realClientFactory: () => Effect.Effect<
    RealClientHandle,
    RealClientLifecycleError,
    Scope.Scope
  >;
  readonly handshakeWindow: ClientHandshakeWindow;
  readonly toxiproxy: ToxiproxyClient | null;
  readonly opts: ClientConformanceRunOptions;
  readonly seed: number;
  readonly artifacts: Ref.Ref<ReadonlyArray<ConformanceArtifact>>;
}

export interface ClientConformanceRunOptions {
  readonly tiers: ReadonlyArray<"A" | "B" | "C" | "D" | "E">;
  readonly realClient: () => Effect.Effect<
    RealClientHandle,
    RealClientLifecycleError,
    Scope.Scope
  >;
  readonly replaySeed?: number;
  readonly numRuns?: number;
  readonly manageToxiproxy?: boolean;
  readonly toxiproxyUrl?: string;
  readonly artifactDir?: string;
  /**
   * If `true`, TestServer binds behind a Toxiproxy upstream matching the
   * adversity-tier `downstream` port; otherwise a direct bind. Default:
   * `true` when `tiers` includes `"D"`.
   */
  readonly bindThroughToxiproxy?: boolean;
}

/**
 * Acquire the full client-side context under one Scope. Returns a
 * live TestServer, a real-client factory ready to call, and a
 * handshake-noise guard window.
 *
 * Errors are typed; no raw throws.
 */
export function acquireClientRunContext(
  opts: ClientConformanceRunOptions,
): Effect.Effect<
  ClientConformanceRunContext,
  ToxicControlError | RealServerAcquireError | RealClientLifecycleError,
  Scope.Scope
> {
  throw new Error("not implemented");
}

/**
 * Build a `ClientHandshakeWindow` from a real-client handle. The window
 * tracks the most recent handshake-complete signal so emissions block
 * until `ready` resolves.
 */
export function makeClientHandshakeWindow(
  handle: RealClientHandle,
): Effect.Effect<ClientHandshakeWindow, never, Scope.Scope> {
  throw new Error("not implemented");
}
