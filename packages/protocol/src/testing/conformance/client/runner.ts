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
import { Context, Effect, Ref, type Scope } from "effect";
import type { EventFrame, ResponseFrame } from "../../../schema/frames.js";
import {
  makeTestServer,
  type TestServer,
  type TestServerConnection,
} from "../../test-server.js";
import {
  makeToxiproxyClient,
  type ToxiproxyClient,
} from "../../toxics/client.js";
import {
  RealServerAcquireError,
  TransportIoError,
  type ToxicControlError,
} from "../../errors.js";
import type { ConformanceArtifact } from "../runner.js";
import { PROTOCOL_VERSION } from "../../../version.js";

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
/**
 * Factory arguments the suite passes to every `realClient()` invocation.
 * The factory uses `testServerUrl` to point its WS client at the bound
 * TestServer substrate.
 */
export interface RealClientFactoryArgs {
  readonly testServerUrl: string;
}

export interface ClientConformanceRunContext {
  readonly testServer: TestServer;
  readonly realClientFactory: (
    args: RealClientFactoryArgs,
  ) => Effect.Effect<RealClientHandle, RealClientLifecycleError, Scope.Scope>;
  readonly handshakeWindow: ClientHandshakeWindow;
  readonly toxiproxy: ToxiproxyClient | null;
  readonly opts: ClientConformanceRunOptions;
  readonly seed: number;
  readonly artifacts: Ref.Ref<ReadonlyArray<ConformanceArtifact>>;
}

export interface ClientConformanceRunOptions {
  readonly tiers: ReadonlyArray<"A" | "B" | "C" | "D" | "E">;
  readonly realClient: (
    args: RealClientFactoryArgs,
  ) => Effect.Effect<RealClientHandle, RealClientLifecycleError, Scope.Scope>;
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
 * The TestServer binds on an ephemeral port. Optional Toxiproxy is
 * acquired when `manageToxiproxy` is set or `toxiproxyUrl` is provided
 * alongside tier "D".
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
  return Effect.gen(function* () {
    const seed =
      opts.replaySeed ?? Number(process.env.FC_SEED ?? Date.now() & 0x7fffffff);
    const artifacts = yield* Ref.make<ReadonlyArray<ConformanceArtifact>>([]);

    // Bind the TestServer under the ambient Scope. Server-close on teardown.
    const testServer = yield* makeTestServer({
      port: 0,
      host: "127.0.0.1",
      captureCapacity: 256,
    }).pipe(
      Effect.mapError(
        (err) =>
          new RealServerAcquireError({
            cause: new Error(`TestServer bind failed: ${String(err)}`),
          }),
      ),
    );

    // Optional Toxiproxy acquisition — matches the server-side runner's
    // contract (only allocate when tier "D" is present).
    let toxiproxy: ToxiproxyClient | null = null;
    if (opts.tiers.includes("D") && opts.toxiproxyUrl !== undefined) {
      const tp = yield* makeToxiproxyClient({ apiUrl: opts.toxiproxyUrl });
      yield* tp.ping.pipe(Effect.orElseSucceed(() => undefined));
      toxiproxy = tp;
    }

    // Build a placeholder handshake window; property bodies overwrite it
    // via `makeClientHandshakeWindow(handle)` once they have a handle.
    // The context carries the initial no-op shape so type-system contracts
    // hold; each property body still binds a per-handle window.
    const handshakeWindow: ClientHandshakeWindow = {
      freshEmissionTag: Effect.sync(
        () => `tag-${Math.random().toString(36).slice(2, 10)}`,
      ),
      emitTaggedEvent: ({ connection, base, emissionTag }) =>
        emitTaggedEventDefault(connection, base, emissionTag),
      emitTaggedResponse: ({ connection, base, emissionTag }) =>
        emitTaggedResponseDefault(connection, base, emissionTag),
      awaitHandshakeComplete: Effect.void,
    };

    return {
      testServer,
      realClientFactory: opts.realClient,
      handshakeWindow,
      toxiproxy,
      opts,
      seed,
      artifacts,
    } satisfies ClientConformanceRunContext;
  });
}

/**
 * Default tagged-event emission: stamp the event payload with the
 * caller's `emissionTag` under the reserved `__emissionTag` key, then
 * forward to the connection's real `emitEvent`. Returns the tag so the
 * caller can filter subscriber observations by the same string.
 *
 * `EventFrame.data` is `Type.Optional(Type.Unknown())`; injecting an
 * object field is schema-valid. The real clients under test are
 * payload-opaque (C3 predicate), so the extra field round-trips cleanly.
 */
function emitTaggedEventDefault(
  connection: TestServerConnection,
  base: EventFrame,
  emissionTag: string,
): Effect.Effect<string> {
  const base_data = (base.data ?? {}) as Record<string, unknown>; // #ignore-sloppy-code[record-cast]: EventFrame.data is Type.Optional(Type.Unknown()); opaque-payload merge, not a Kysely row
  const tagged: EventFrame = {
    ...base,
    data: { ...base_data, __emissionTag: emissionTag },
  };
  return connection.emitEvent(tagged).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.as(emissionTag),
  );
}

function emitTaggedResponseDefault(
  connection: TestServerConnection,
  base: ResponseFrame,
  _emissionTag: string,
): Effect.Effect<string> {
  // Response frames don't carry a free-form `data` field; responses are
  // correlated by `id` instead — the response's `id` IS its emission tag
  // from the property's perspective (see B1 / B4 / D5 predicates).
  return connection.emitResponse(base).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.as(base.id),
  );
}

/**
 * Build a `ClientHandshakeWindow` from a real-client handle. Returns a
 * window whose `awaitHandshakeComplete` resolves when `handle.ready`
 * does; emissions are passed through to the connection the property
 * body chooses (TestServer may have multiple connections).
 */
export function makeClientHandshakeWindow(
  handle: RealClientHandle,
): Effect.Effect<ClientHandshakeWindow, never, Scope.Scope> {
  return Effect.gen(function* () {
    const tagCounter = yield* Ref.make(0);
    return {
      freshEmissionTag: Ref.updateAndGet(tagCounter, (n) => n + 1).pipe(
        Effect.map((n) => `emit-${handle.agentId}-${n}`),
      ),
      emitTaggedEvent: ({ connection, base, emissionTag }) =>
        emitTaggedEventDefault(connection, base, emissionTag),
      emitTaggedResponse: ({ connection, base, emissionTag }) =>
        emitTaggedResponseDefault(connection, base, emissionTag),
      awaitHandshakeComplete: handle.ready,
    };
  });
}

/**
 * Auto-handshake responder. Spawned as a background fiber by property
 * bodies; watches a TestServer connection's inbound capture buffer for
 * `auth/connect` RPC requests and responds with a minimal valid
 * `HelloOkSchema`. Required because `MoltZapWsClient.connect()` blocks
 * on the auth/connect response before `ready` resolves.
 *
 * Exposed as a helper so each property body can choose whether to run
 * the auto-responder or assert directly against the raw inbound stream
 * (e.g., B4 spurious-id test wants to observe the inbound ids).
 */
export function runAutoHandshakeResponder(
  connection: TestServerConnection,
  agentId: string,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.forkScoped(
    Effect.gen(function* () {
      let handshakeHandled = false;
      while (!handshakeHandled) {
        yield* Effect.sleep("10 millis");
        const snap = yield* connection.inbound.snapshot;
        for (const entry of snap) {
          if (
            entry.kind === "inbound" &&
            entry.frame !== null &&
            entry.frame.type === "request" &&
            entry.frame.method === "auth/connect"
          ) {
            const helloOk = {
              protocolVersion: PROTOCOL_VERSION,
              agentId,
              conversations: [],
              unreadCounts: {},
              policy: {
                maxMessageBytes: 65536,
                maxPartsPerMessage: 32,
                maxTextLength: 4096,
                maxGroupParticipants: 64,
                heartbeatIntervalMs: 30_000,
                rateLimits: {
                  messagesPerMinute: 60,
                  requestsPerMinute: 300,
                },
              },
            };
            yield* connection
              .emitResponse({
                jsonrpc: "2.0",
                type: "response",
                id: entry.frame.id,
                result: helloOk,
              })
              .pipe(Effect.orElseSucceed(() => undefined));
            handshakeHandled = true;
            break;
          }
        }
      }
    }),
  ).pipe(Effect.asVoid);
}

/**
 * Utility: resolve a fresh tag from a handshake window in synchronous-
 * friendly Effect code. Property bodies call this at the top of each
 * fast-check iteration.
 */
export function freshTag(window: ClientHandshakeWindow): Effect.Effect<string> {
  return window.freshEmissionTag;
}

/**
 * Fiber-safe helper to await a TestServer connection. Times out so a
 * never-connecting real client doesn't block the property body
 * indefinitely.
 */
export function awaitConnection(
  testServer: TestServer,
  timeoutMs = 5000,
): Effect.Effect<TestServerConnection, TransportIoError> {
  return testServer.accept.pipe(
    Effect.timeoutFail({
      duration: `${timeoutMs} millis`,
      onTimeout: () =>
        new TransportIoError({
          direction: "inbound",
          cause: new Error(
            `TestServer accept timeout after ${timeoutMs}ms (no real client connected)`,
          ),
        }),
    }),
  );
}
