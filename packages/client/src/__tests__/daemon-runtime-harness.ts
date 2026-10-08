/** @file A daemon runtime harness over fake engine, worker, store and Registry and Router services, for lifecycle tests. */

import { NodeFileSystem } from "@effect/platform-node";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import { type Context, Deferred, Effect } from "effect";
import type { EventStore } from "../delivery/operations.js";
import type { Fixture } from "./daemon-runtime-fixtures.js";
import { makeHistoryExport } from "../delivery/history-export.js";
import { INBOX_PENDING_EVENT } from "../endpoint/mcp/names.js";
import {
  type HarnessMcpEventHandler,
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "../endpoint/mcp/tools.js";
import {
  type DaemonRuntimeDependencies,
  DaemonRuntimeError,
  runDaemonRuntime,
} from "../service/lifecycle.js";
import { readDaemonRegistrationState } from "../service/registration/index.js";
import {
  type DeliveryToken,
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
  type IdentityBinding,
} from "../store/index.js";
import {
  DeliveryAcknowledgeError,
  ListenError,
} from "../transport/messaging/errors.js";
import {
  type EndpointEngine,
  EngineOutboundError,
  type EnginePendingMessage,
} from "../transport/messaging/index.js";
import {
  type RouterWorker,
  RouterWorkerPersistenceError,
} from "../transport/router/index.js";
import { sameBytes } from "../transport/wire/index.js";
import { unusedEndpointStore } from "./unused-endpoint-store.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- The focused tests drive the official Promise-native MCP stream boundary. */

/** The MCP handler the daemon installed; throws before installation. */
export function requireHandler(
  harness: RuntimeHarness,
): HarnessMcpEventHandler {
  const handler = harness.getHandler();
  if (handler === undefined) {
    throw new Error("missing composed MCP handler");
  }
  return handler;
}

/** The event store the daemon gave its MCP handler; throws before installation. */
export function requireEventStore(harness: RuntimeHarness): EventStore {
  const eventStore = harness.getEventStore();
  if (eventStore === undefined) {
    throw new Error("missing composed event store");
  }
  return eventStore;
}

/** The MCP operations the daemon installed; throws before installation. */
export function requireOperations(
  harness: RuntimeHarness,
): HarnessMcpOperations {
  const operations = harness.getOperations();
  if (operations === undefined) {
    throw new Error("missing composed MCP operations");
  }
  return operations;
}

const SUBSCRIPTIONS_LISTEN_METHOD = "events/stream";
/** The notification acknowledging an MCP Events subscription. */
export const SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION =
  "notifications/events/active";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** The failure a supervised background fiber's exit raises in the daemon. */
export const EXPECTED_LISTENER_FAILURE = new DaemonRuntimeError({
  phase: "listener",
});

/**
 * The fake engine's one pending delivery and what happened to it. The fake
 * store's inbox acknowledgment also marks it acknowledged here, as production
 * `retireItem` retires the item's pending delivery in the same transaction, so
 * both fakes append to one `acknowledgedTokens`.
 */
interface DeliveryState {
  readonly pending: EnginePendingMessage;
  readonly acknowledgedTokens: Array<typeof DeliveryToken.Type>;
  readonly events: string[];
  acknowledged: boolean;
  readBarrier?: ReadBarrier;
  failReads?: boolean;
}

/** Holds the harness engine's next pending read until released. */
export interface ReadBarrier {
  readonly entered: Deferred.Deferred<undefined>;
  readonly release: Deferred.Deferred<undefined>;
}

interface HarnessSignals {
  readonly engineEntered: Deferred.Deferred<undefined>;
  readonly engineRelease: Deferred.Deferred<undefined>;
  readonly failure: Deferred.Deferred<undefined>;
  readonly listenerReady: Deferred.Deferred<undefined>;
}

interface HarnessObservations {
  handler?: HarnessMcpEventHandler;
  eventStore?: EventStore;
  operations?: HarnessMcpOperations;
  historyExportPath?: string;
}

interface RuntimeDependenciesInput {
  readonly background: BackgroundFailure;
  readonly blockEngine: boolean;
  readonly delivery: DeliveryState;
  readonly observations: HarnessObservations;
  readonly signals: HarnessSignals;
}

/** The harness's dependencies, signals, observations and captured edges. */
export interface RuntimeHarness {
  readonly dependencies: DaemonRuntimeDependencies;
  readonly delivery: DeliveryState;
  readonly engineEntered: Deferred.Deferred<undefined>;
  readonly engineRelease: Deferred.Deferred<undefined>;
  readonly failure: Deferred.Deferred<undefined>;
  readonly listenerReady: Deferred.Deferred<undefined>;
  readonly getEventStore: () => EventStore | undefined;
  readonly getHandler: () => HarnessMcpEventHandler | undefined;
  readonly getOperations: () => HarnessMcpOperations | undefined;
  readonly getHistoryExportPath: () => string | undefined;
}

type BackgroundFailure = "none" | "outbound" | "worker";

const emptyRecovery = (identity?: IdentityBinding): EndpointRecovery => ({
  identity,
  postIntents: [],
  memberships: [],
  anchors: [],
  positions: [],
  proposalLocks: [],
  stagedRecords: [],
  evidence: [],
  certifiedRecords: [],
  stagedReanchors: [],
  pendingDeliveries: [],
  disseminationObligations: [],
  outboundMessages: [],
});

const makeInboxStore = (onAcknowledge: (token: DeliveryToken) => void) => {
  const inbox = new Map<DeliveryToken, Uint8Array>();
  const acknowledged = new Set<DeliveryToken>();
  return {
    readInbox: () =>
      Effect.succeed({
        items: [...inbox]
          .filter(([token]) => !acknowledged.has(token))
          .map(([deliveryToken, canonicalItem], index) => ({
            sequence: index + 1,
            deliveryToken,
            canonicalItem,
          })),
        through: inbox.size,
      }),
    readInboxSummary: () =>
      Effect.succeed({
        pendingCount: [...inbox.keys()].filter(
          (token) => !acknowledged.has(token),
        ).length,
        newestSequence: inbox.size,
      }),
    putInboxItem: (item) =>
      Effect.sync(() => {
        inbox.set(item.deliveryToken, item.canonicalItem);
        return "inserted" as const;
      }),
    acknowledgeInboxItem: (token) =>
      Effect.sync(() => {
        acknowledged.add(token);
        onAcknowledge(token);
      }),
  } satisfies Pick<
    EndpointStore,
    "readInbox" | "readInboxSummary" | "putInboxItem" | "acknowledgeInboxItem"
  >;
};

/**
 * A store over the fixture's identity, bound when `active`, whose inbox lives
 * in memory and whose acknowledgments are recorded in the harness delivery.
 */
export function makeStore(
  fixture: Fixture,
  active: boolean,
  delivery?: DeliveryState,
): EndpointStore {
  const onAcknowledge = (token: DeliveryToken) => {
    if (delivery !== undefined) {
      delivery.acknowledged = true;
      delivery.acknowledgedTokens.push(token);
      delivery.events.push("acknowledged");
    }
  };
  let identity: IdentityBinding | undefined = active
    ? {
        agentId: fixture.localCard.agentId,
        canonicalAgentCard: fixture.canonicalLocalCard,
      }
    : undefined;
  return {
    ...unusedEndpointStore("daemon runtime test"),
    readInboxItem: () => Effect.succeed(undefined),
    completeWebhookDelivery: () => Effect.void,
    ...makeInboxStore(onAcknowledge),
    readPendingDeliveries: () => Effect.succeed([]),
    readIdentity: () => Effect.succeed(identity),
    bindIdentity: (candidate) =>
      Effect.suspend(() => {
        if (identity === undefined) {
          identity = candidate;
          return Effect.succeed("inserted" as const);
        }
        if (
          identity.agentId !== candidate.agentId ||
          !sameBytes(identity.canonicalAgentCard, candidate.canonicalAgentCard)
        ) {
          return Effect.fail(new EndpointStoreError({ reason: "conflict" }));
        }
        return Effect.succeed("existing" as const);
      }),
    recover: () => Effect.succeed(emptyRecovery(identity)),
  };
}

function makeServices(fixture: Fixture) {
  const registry: Context.Tag.Service<typeof Registry> = {
    register: () =>
      Effect.succeed({ kind: "registered", agentCard: fixture.localCard }),
    lookup: () => Effect.succeed({ kind: "not_found" }),
    list: () =>
      Effect.succeed({ kind: "page", agentCards: [], hasMore: false }),
  };
  const router: Context.Tag.Service<typeof Router> = {
    send: () => outsideRuntimeTest(),
    poll: () => outsideRuntimeTest(),
  };
  return { registry, router };
}

const makeHarnessSignals: Effect.Effect<HarnessSignals> = Effect.gen(
  function* () {
    return {
      engineEntered: yield* Deferred.make<undefined>(),
      engineRelease: yield* Deferred.make<undefined>(),
      failure: yield* Deferred.make<undefined>(),
      listenerReady: yield* Deferred.make<undefined>(),
    };
  },
);

const closeHandler = (handler: HarnessMcpEventHandler) =>
  Effect.tryPromise({
    try: () => handler.close(),
    catch: () => new Error("failed to close test MCP handler"),
  }).pipe(Effect.ignore);

/**
 * The production history export, opened at the configured path. The harness
 * notes the path so a test can tell whether the daemon opened an export.
 */
const observedHistoryExport = (
  observations: HarnessObservations,
  path: string,
) =>
  Effect.sync(() => {
    observations.historyExportPath = path;
  }).pipe(
    Effect.zipRight(
      makeHistoryExport(path).pipe(Effect.provide(NodeFileSystem.layer)),
    ),
  );

function makeRuntimeDependencies(
  input: RuntimeDependenciesInput,
): DaemonRuntimeDependencies {
  const worker = makeWorker(input.background, input.signals);
  const engine = makeEngine(input.background, input.signals, input.delivery);
  return {
    makeWorker: () => Effect.succeed(worker),
    makeEngine: () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(input.signals.engineEntered, undefined);
        if (input.blockEngine) {
          yield* Deferred.await(input.signals.engineRelease);
        }
        return engine;
      }),
    makeHandler: (options) =>
      Effect.sync(() => {
        input.observations.operations = options.operations;
        input.observations.eventStore = options.eventStore;
      }).pipe(Effect.zipRight(makeHarnessMcpHttpHandler(options))),
    acquireListener: ({ handler }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          input.observations.handler = handler;
        }).pipe(
          Effect.zipRight(
            Deferred.succeed(input.signals.listenerReady, undefined),
          ),
        ),
        () => closeHandler(handler),
      ).pipe(Effect.asVoid),
    makeHistoryExport: (path) =>
      observedHistoryExport(input.observations, path),
  };
}

function makeWorker(
  background: BackgroundFailure,
  signals: HarnessSignals,
): RouterWorker {
  const failure = Deferred.await(signals.failure).pipe(
    Effect.zipRight(Effect.fail(new RouterWorkerPersistenceError())),
  );
  return {
    awaitAnchor: outsideRuntimeTest(),
    currentAnchor: outsideRuntimeTest(),
    pollOnce: outsideRuntimeTest(),
    run: background === "worker" ? failure : Effect.never,
    send: () => outsideRuntimeTest(),
  };
}

function outsideRuntimeTest<Value>(): Effect.Effect<Value> {
  return Effect.dieMessage("outside daemon runtime test");
}

/** The harness engine's pending read: fails, waits at a barrier, or returns. */
const readPending = (delivery: DeliveryState) =>
  Effect.gen(function* () {
    if (delivery.failReads === true) {
      return yield* Effect.fail(
        new ListenError({ reason: "transport-failed" }),
      );
    }
    const messages = delivery.acknowledged ? [] : [delivery.pending];
    const barrier = delivery.readBarrier;
    delivery.readBarrier = undefined;
    if (barrier !== undefined) {
      yield* Deferred.succeed(barrier.entered, undefined);
      yield* Deferred.await(barrier.release);
    }
    delivery.events.push("delivery-ready");
    return messages;
  });

function makeEngine(
  background: BackgroundFailure,
  signals: HarnessSignals,
  delivery: DeliveryState,
): EndpointEngine {
  const failure = Deferred.await(signals.failure).pipe(
    Effect.zipRight(
      Effect.fail(new EngineOutboundError({ reason: "persistence" })),
    ),
  );
  return {
    send: () =>
      Effect.succeed({
        postId: delivery.pending.message.postId,
        recordHash: delivery.pending.recordHash,
      }),
    resolveAddress: () => Effect.void,
    readPendingMessages: () => readPending(delivery),
    acknowledgeMessage: (deliveryToken) =>
      deliveryToken !== delivery.pending.deliveryToken
        ? Effect.fail(
            new DeliveryAcknowledgeError({ reason: "unknown-delivery" }),
          )
        : Effect.sync(() => {
            delivery.acknowledged = true;
            delivery.acknowledgedTokens.push(deliveryToken);
            delivery.events.push("acknowledged");
          }),
    acceptRouterIngress: () => Effect.succeed("ignored"),
    acceptRecoveryIngress: () => Effect.succeed("ignored"),
    recoverCertifiedHistory: () => Effect.void,
    drainOutbound: Effect.void,
    runOutbound: background === "outbound" ? failure : Effect.never,
    abandonVolatileFolds: () => Effect.void,
    rearmCatchUp: Effect.void,
  };
}

/** A harness whose fake engine and worker fail in the named background. */
export const makeHarness = (
  fixture: Fixture,
  background: BackgroundFailure,
  blockEngine = false,
): Effect.Effect<RuntimeHarness> =>
  Effect.gen(function* () {
    const signals = yield* makeHarnessSignals;
    const observations: HarnessObservations = {};
    const delivery: DeliveryState = {
      pending: fixture.pending,
      acknowledged: false,
      acknowledgedTokens: [],
      events: [],
    };
    const dependencies = makeRuntimeDependencies({
      background,
      blockEngine,
      delivery,
      observations,
      signals,
    });
    return {
      dependencies,
      delivery,
      ...signals,
      getEventStore: () => observations.eventStore,
      getHandler: () => observations.handler,
      getOperations: () => observations.operations,
      getHistoryExportPath: () => observations.historyExportPath,
    };
  }).pipe(Effect.withSpan("makeHarness"));

/**
 * Run the daemon over the harness and the fixture's Registry and Router,
 * from the registration state the store holds, read once as startup does.
 */
export const run = (
  fixture: Fixture,
  store: EndpointStore,
  harness: RuntimeHarness,
) => {
  const services = makeServices(fixture);
  return readDaemonRegistrationState({
    store,
    bootstrap: fixture.bootstrap,
  }).pipe(
    Effect.orDie,
    Effect.flatMap((registration) =>
      runDaemonRuntime(
        { store, bootstrap: fixture.bootstrap, registration },
        harness.dependencies,
      ),
    ),
    Effect.provideService(Registry, services.registry),
    Effect.provideService(Router, services.router),
    Effect.scoped,
  );
};

interface McpRequestInput {
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** One modern MCP request to the daemon's loopback handler. */
const makeMcpRequest = (input: McpRequestInput): Request =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": input.method,
      ...input.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.id,
      method: input.method,
      params: {
        ...input.params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: {
            name: "daemon-runtime-test-client",
            version: "1.0.0",
          },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

/** An MCP Events subscription request with the given id. */
export const makeListenRequest = (id: string): Request =>
  makeMcpRequest({
    id,
    method: SUBSCRIPTIONS_LISTEN_METHOD,
    params: { name: INBOX_PENDING_EVENT, arguments: {}, cursor: null },
  });

/** A `tools/list` request with the given id. */
export const makeToolListRequest = (id: string): Request =>
  makeMcpRequest({ id, method: "tools/list", params: {} });

/**
 * A `tools/call` request with the given id. Aborting `signal` cancels it, as
 * a client that drops the request does.
 */
export const makeToolCallRequest = (input: {
  readonly id: string;
  readonly name: string;
  readonly toolArguments: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}): Request =>
  makeMcpRequest({
    id: input.id,
    method: "tools/call",
    params: { name: input.name, arguments: input.toolArguments },
    headers: { "mcp-name": input.name },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

/** A reader over a streamed MCP response body. */
export const responseReader = (
  response: Response,
): ReadableStreamDefaultReader<Uint8Array> => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("expected retained SSE response body");
  }
  return reader;
};

const frameBuffers = new WeakMap<
  ReadableStreamDefaultReader<Uint8Array>,
  string
>();
const frameData = (frame: string): string =>
  frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

const readChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> => {
  const result = await reader.read();
  if (result.done) {
    throw new Error("Expected an SSE data frame");
  }
  return new TextDecoder().decode(result.value);
};

const readFrame = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown> => {
  let buffered = frameBuffers.get(reader) ?? "";
  while (true) {
    const end = buffered.indexOf("\n\n");
    if (end >= 0) {
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      frameBuffers.set(reader, buffered);
      const data = frameData(frame);
      if (data !== "") {
        return JSON.parse(data);
      }
    } else {
      buffered += await readChunk(reader);
    }
  }
};

/** Await an effect for one named stage, failing after one second. */
export const awaitStage = <Value, Failure>(
  effect: Effect.Effect<Value, Failure>,
  stage: string,
): Promise<Value> =>
  Effect.runPromise(
    effect.pipe(
      Effect.timeoutFail({
        duration: "1 second",
        onTimeout: () => new Error(`timed out awaiting ${stage}`),
      }),
    ),
  );

/** Await the next server-sent frame for one named stage. */
export const awaitFrame = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stage: string,
): Promise<unknown> =>
  awaitStage(
    Effect.tryPromise({
      try: () => readFrame(reader),
      catch: () => new Error(`failed to read ${stage}`),
    }),
    stage,
  );

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore repository defaults after the harness. */
