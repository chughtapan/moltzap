/** @file Focused daemon activation, supervision, and durable delivery tests. */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/server";
import {
  AgentCard,
  AgentId,
  AgentName,
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
  PrincipalId,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import canonicalize from "canonicalize";
import {
  type Context,
  Deferred,
  Effect,
  Encoding,
  Fiber,
  Option,
  Redacted,
  Schema,
} from "effect";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DaemonBootstrap } from "../configuration.js";
import {
  DeliveryAcknowledgeError,
  type HistoryExportRecord,
  InboundItem,
  InboundMessage,
} from "../../contract.js";
import {
  type EndpointEngine,
  EngineOutboundError,
  type EnginePendingMessage,
} from "../../endpoint/engine.js";
import { encodeCanonical, RecordHash } from "../../endpoint/representation.js";
import {
  type RouterWorker,
  type RouterWorkerInput,
  RouterWorkerPersistenceError,
} from "../../endpoint/router-worker/index.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
  type IdentityBinding,
} from "../../endpoint/store.js";
import {
  type EventStore,
  INBOX_PENDING_EVENT,
} from "../../harness-mcp-contract.js";
import {
  type HarnessMcpEventHandler,
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "../../harness-mcp-wire.js";
import { managementRegisterRequestSchema } from "../../management-runtime.js";
import {
  type DaemonRuntimeDependencies,
  DaemonRuntimeError,
  runDaemonRuntime,
} from "./index.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- The focused tests drive the official Promise-native MCP stream boundary. */

const SUBSCRIPTIONS_LISTEN_METHOD = "events/stream";
const SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION = "notifications/events/active";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const EXPECTED_LISTENER_FAILURE = new DaemonRuntimeError({
  phase: "listener",
});

interface Fixture {
  readonly bootstrap: DaemonBootstrap;
  readonly localCard: VerifiedAgentCard;
  readonly canonicalLocalCard: Uint8Array;
  readonly registerRequest: typeof managementRegisterRequestSchema.Type;
  readonly pending: EnginePendingMessage;
}

interface DeliveryState {
  readonly pending: EnginePendingMessage;
  readonly acknowledgedTokens: Array<typeof DeliveryToken.Type>;
  readonly events: string[];
  acknowledged: boolean;
  readBarrier?: ReadBarrier;
  reads: number;
}

interface ReadBarrier {
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
  readonly events: string[];
  handler?: HarnessMcpEventHandler;
  eventStore?: EventStore;
  readonly records: HistoryExportRecord[];
  operations?: HarnessMcpOperations;
  historyExportPath?: string;
  workerOutbox?: RouterWorkerInput["outbox"];
}

interface RuntimeDependenciesInput {
  readonly background: BackgroundFailure;
  readonly blockEngine: boolean;
  readonly delivery: DeliveryState;
  readonly observations: HarnessObservations;
  readonly signals: HarnessSignals;
}

interface RuntimeHarness {
  readonly dependencies: DaemonRuntimeDependencies;
  readonly delivery: DeliveryState;
  readonly engineEntered: Deferred.Deferred<undefined>;
  readonly engineRelease: Deferred.Deferred<undefined>;
  readonly events: string[];
  readonly failure: Deferred.Deferred<undefined>;
  readonly listenerReady: Deferred.Deferred<undefined>;
  readonly records: HistoryExportRecord[];
  readonly getEventStore: () => EventStore | undefined;
  readonly getHandler: () => HarnessMcpEventHandler | undefined;
  readonly getOperations: () => HarnessMcpOperations | undefined;
  readonly getWorkerOutbox: () => RouterWorkerInput["outbox"] | undefined;
  readonly getHistoryExportPath: () => string | undefined;
}

type BackgroundFailure = "none" | "outbound" | "worker";

const EXPORT_PATH = "/var/run/moltzap/history.ndjson";

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const digest = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`;

const makeAuthority = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
};

const issueCard = (input: {
  readonly authority: AgentSigningAuthorityValue;
  readonly registryPrivateKey: KeyObject;
  readonly registrySignerPublicKey: typeof Ed25519PublicKey.Type;
}): Effect.Effect<VerifiedAgentCard> =>
  Effect.gen(function* () {
    const thumbprint = createHash("sha256")
      .update(canonicalize(input.registrySignerPublicKey) ?? "")
      .digest("base64url");
    const protectedText = canonicalize({
      alg: "Ed25519",
      kid: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${thumbprint}`,
      typ: "application/vnd.moltzap.agent-card+jws",
    });
    const payloadText = canonicalize({
      agentId: Schema.decodeUnknownSync(AgentId)(identifier("agt_", 1)),
      agentName: Schema.decodeUnknownSync(AgentName)("alice"),
      issuedAt: "2026-08-27T12:00:00Z",
      kind: "agentCard",
      moltzapVersion: MOLTZAP_VERSION,
      principalId: Schema.decodeUnknownSync(PrincipalId)(identifier("prn_", 2)),
      publicKey: AgentSigningAuthority.publicKey(input.authority),
    });
    if (protectedText === undefined || payloadText === undefined) {
      return yield* Effect.dieMessage("canonical card fixture failed");
    }
    const protectedValue = Buffer.from(protectedText).toString("base64url");
    const payload = Buffer.from(payloadText).toString("base64url");
    const signature = signBytes(
      null,
      Buffer.from(`${protectedValue}.${payload}`),
      input.registryPrivateKey,
    ).toString("base64url");
    const card = yield* Schema.decodeUnknown(AgentCard)({
      payload,
      signatures: [{ protected: protectedValue, signature }],
    });
    return yield* AgentCard.verify({
      agentCard: card,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
  }).pipe(Effect.orDie);

const makePendingMessage = Effect.all({
  deliveryToken: Schema.decodeUnknown(DeliveryToken)(digest("dlv_", 4)),
  recordHash: Schema.decodeUnknown(RecordHash)(digest("rch_", 6)),
  message: Schema.decodeUnknown(InboundMessage)({
    kind: "direct",
    postId: digest("pst_", 5),
    address: "agent:bob",
    sender: "agent:bob",
    content: [{ type: "text", text: "certified" }],
  }),
});

const makeFixture = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const signingAuthority = yield* makeAuthority();
  const localCard = yield* issueCard({
    authority: signingAuthority,
    registryPrivateKey: registryKeys.privateKey,
    registrySignerPublicKey,
  });
  const bootstrap: DaemonBootstrap = Object.freeze({
    configuration: {
      stateDirectory: "/var/lib/moltzapd",
      mcpPort: 4319,
      registryOrigin: new URL("https://registry.example"),
      registrySignerPublicKey,
      routerOrigin: new URL("https://router.example"),
      agentPrivateKeyFile: Redacted.make("/run/secrets/agent.pem"),
      admissionCredentialFile: Redacted.make("/run/secrets/admission"),
    },
    signingAuthority,
    agentPublicKey: AgentSigningAuthority.publicKey(signingAuthority),
    admissionCredential: Effect.succeed(Redacted.make("bootstrap-token=")),
  });
  const registerRequest = yield* Schema.decodeUnknown(
    managementRegisterRequestSchema,
  )({
    operationId: identifier("opn_", 3),
    principalId: localCard.principalId,
    agentName: localCard.agentName,
  });
  return {
    bootstrap,
    localCard,
    canonicalLocalCard: yield* encodeCanonical(AgentCard, localCard),
    registerRequest,
    pending: yield* makePendingMessage,
  } satisfies Fixture;
}).pipe(Effect.orDie);

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

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

const inactiveStoreOperations: Omit<
  EndpointStore,
  "readIdentity" | "bindIdentity" | "recover"
> = {
  readInboxItem: () => Effect.succeed(undefined),
  completeWebhookDelivery: () => Effect.void,
  putInboxItem: () => outsideRuntimeTest(),
  readInbox: () => outsideRuntimeTest(),
  readInboxSummary: () => outsideRuntimeTest(),
  acknowledgeInboxItem: () => outsideRuntimeTest(),
  replaceInboxItem: () => outsideRuntimeTest(),
  beginSendAttempt: () => outsideRuntimeTest(),
  finishSendAttempt: () => outsideRuntimeTest(),
  readSendAttempt: () => outsideRuntimeTest(),
  readEventState: () => outsideRuntimeTest(),
  writeEventState: () => outsideRuntimeTest(),
  bindPostIntent: () => outsideRuntimeTest(),
  putConversationFoundation: () => outsideRuntimeTest(),
  lockProposal: () => outsideRuntimeTest(),
  lockGenesisProposal: () => outsideRuntimeTest(),
  stageRecord: () => outsideRuntimeTest(),
  stageRecordForDissemination: () => outsideRuntimeTest(),
  mergeEvidence: () => outsideRuntimeTest(),
  promoteRecord: () => outsideRuntimeTest(),
  promoteRecordForDissemination: () => outsideRuntimeTest(),
  applyCatchUpRecord: () => outsideRuntimeTest(),
  stageReanchor: () => outsideRuntimeTest(),
  completeReanchor: () => outsideRuntimeTest(),
  applyCatchUpReanchor: () => outsideRuntimeTest(),
  readPendingDeliveries: () => outsideRuntimeTest(),
  readLegacyPendingDeliveries: () => outsideRuntimeTest(),
  acknowledgeDelivery: () => outsideRuntimeTest(),
  enqueueOutbound: () => outsideRuntimeTest(),
  enqueueDisseminationOutbound: () => outsideRuntimeTest(),
  beginOutbound: () => outsideRuntimeTest(),
  replaceOutbound: () => outsideRuntimeTest(),
  completeOutbound: () => outsideRuntimeTest(),
  discardOutbound: () => outsideRuntimeTest(),
  restartEmptyConversation: () => outsideRuntimeTest(),
  searchConversations: () => outsideRuntimeTest(),
  readConversation: () => outsideRuntimeTest(),
  releaseContinuation: () => outsideRuntimeTest(),
};

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

function makeStore(
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
    ...inactiveStoreOperations,
    ...makeInboxStore(onAcknowledge),
    readPendingDeliveries: () => Effect.succeed([]),
    readLegacyPendingDeliveries: () => Effect.succeed([]),
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

const recordingExport = (observations: HarnessObservations, path: string) =>
  Effect.sync(() => {
    observations.historyExportPath = path;
    return {
      record: (record: HistoryExportRecord) =>
        Effect.sync(() => {
          observations.records.push(record);
        }),
    };
  });

function makeRuntimeDependencies(
  input: RuntimeDependenciesInput,
): DaemonRuntimeDependencies {
  const worker = makeWorker(input.background, input.signals);
  const engine = makeEngine(input.background, input.signals, input.delivery);
  return {
    makeWorker: (workerInput) =>
      Effect.sync(() => {
        input.observations.events.push("worker");
        input.observations.workerOutbox = workerInput.outbox;
        return worker;
      }),
    makeEngine: () =>
      Effect.gen(function* () {
        input.observations.events.push("engine");
        yield* Deferred.succeed(input.signals.engineEntered, undefined);
        if (input.blockEngine) {
          yield* Deferred.await(input.signals.engineRelease);
        }
        return engine;
      }),
    makeHandler: (options) =>
      Effect.sync(() => {
        input.observations.events.push("handler");
        input.observations.operations = options.operations;
        input.observations.eventStore = options.eventStore;
      }).pipe(Effect.zipRight(makeHarnessMcpHttpHandler(options))),
    acquireListener: ({ handler }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          input.observations.events.push("listener");
          input.observations.handler = handler;
        }).pipe(
          Effect.zipRight(
            Deferred.succeed(input.signals.listenerReady, undefined),
          ),
        ),
        () => closeHandler(handler),
      ).pipe(Effect.asVoid),
    makeHistoryExport: (path) => recordingExport(input.observations, path),
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
    readPendingMessages: () =>
      Effect.gen(function* () {
        delivery.reads += 1;
        const messages = delivery.acknowledged ? [] : [delivery.pending];
        const barrier = delivery.readBarrier;
        delivery.readBarrier = undefined;
        if (barrier !== undefined) {
          yield* Deferred.succeed(barrier.entered, undefined);
          yield* Deferred.await(barrier.release);
        }
        delivery.events.push("delivery-ready");
        return messages;
      }),
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
  };
}

const makeHarness = (
  fixture: Fixture,
  background: BackgroundFailure,
  blockEngine = false,
): Effect.Effect<RuntimeHarness> =>
  Effect.gen(function* () {
    const signals = yield* makeHarnessSignals;
    const observations: HarnessObservations = { events: [], records: [] };
    const delivery: DeliveryState = {
      pending: fixture.pending,
      acknowledged: false,
      acknowledgedTokens: [],
      events: [],
      reads: 0,
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
      events: observations.events,
      records: observations.records,
      getEventStore: () => observations.eventStore,
      getHandler: () => observations.handler,
      getOperations: () => observations.operations,
      getWorkerOutbox: () => observations.workerOutbox,
      getHistoryExportPath: () => observations.historyExportPath,
    };
  });

const run = (
  fixture: Fixture,
  store: EndpointStore,
  harness: RuntimeHarness,
) => {
  const services = makeServices(fixture);
  return runDaemonRuntime(
    { store, bootstrap: fixture.bootstrap },
    harness.dependencies,
  ).pipe(
    Effect.provideService(Registry, services.registry),
    Effect.provideService(Router, services.router),
    Effect.scoped,
  );
};

const makeListenRequest = (id: string): Request =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": SUBSCRIPTIONS_LISTEN_METHOD,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: SUBSCRIPTIONS_LISTEN_METHOD,
      params: {
        name: INBOX_PENDING_EVENT,
        arguments: {},
        cursor: null,
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
  });

const responseReader = (
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

const awaitStage = <Value, Failure>(
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

const awaitFrame = (
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

function requireHandler(harness: RuntimeHarness): HarnessMcpEventHandler {
  const handler = harness.getHandler();
  if (handler === undefined) {
    throw new Error("missing composed MCP handler");
  }
  return handler;
}

function requireOperations(harness: RuntimeHarness): HarnessMcpOperations {
  const operations = harness.getOperations();
  if (operations === undefined) {
    throw new Error("missing composed MCP operations");
  }
  return operations;
}

const withHistoryExport = (fixture: Fixture): Fixture => ({
  ...fixture,
  bootstrap: {
    ...fixture.bootstrap,
    configuration: {
      ...fixture.bootstrap.configuration,
      historyExport: EXPORT_PATH,
    },
  },
});

const opensConfiguredHistoryExport = async () => {
  const fixture = withHistoryExport(await Effect.runPromise(makeFixture));
  const harness = await Effect.runPromise(makeHarness(fixture, "none", true));
  const store = makeStore(fixture, true);
  const fiber = Effect.runFork(run(fixture, store, harness));
  try {
    await awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    expect(harness.getHistoryExportPath()).toBe(EXPORT_PATH);
    await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    const deliveryToken = Schema.decodeUnknownSync(DeliveryToken)(
      digest("dlv_", 8),
    );
    const item = Schema.decodeUnknownSync(InboundItem)({
      kind: "operationFailed",
      id: digest("col_", 8),
      to: "agent:bob",
      error: "retained failure",
    });
    const canonicalItem = await Effect.runPromise(encodeRuntimeValue(item));
    await Effect.runPromise(
      store.putInboxItem({ deliveryToken, canonicalItem }),
    );
    const eventStore = harness.getEventStore();
    if (eventStore === undefined) {
      throw new Error("missing composed event store");
    }
    await Effect.runPromise(eventStore.readInbox({ limit: 1 }));
    expect(harness.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "inbound", item }),
      ]),
    );
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

const opensNoHistoryExportByDefault = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none", true));
  const store = makeStore(fixture, true);
  const fiber = Effect.runFork(run(fixture, store, harness));
  try {
    await awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    expect(harness.getHistoryExportPath()).toBeUndefined();
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

const blocksStartupAndSupervisesWorker = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "worker", true));
  const store = makeStore(fixture, true);
  const fiber = Effect.runFork(run(fixture, store, harness));
  try {
    await awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    expect(harness.events).toEqual(["worker", "engine"]);
    expect(harness.getWorkerOutbox()).toBe(store);
    expect(
      Option.isNone(
        await Effect.runPromise(Deferred.poll(harness.listenerReady)),
      ),
    ).toBe(true);

    await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    expect(harness.events).toEqual(["worker", "engine", "handler", "listener"]);

    await Effect.runPromise(Deferred.succeed(harness.failure, undefined));
    const failure = await awaitStage(
      Effect.flip(Fiber.join(fiber)),
      "Router worker supervision",
    );
    expect(failure).toEqual(EXPECTED_LISTENER_FAILURE);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

const failsWhenStartupProjectionCannotPersist = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const harness = yield* makeHarness(fixture, "none");
      const store: EndpointStore = {
        ...makeStore(fixture, true),
        putInboxItem: () =>
          Effect.fail(new EndpointStoreError({ reason: "persistence" })),
      };
      const error = yield* run(fixture, store, harness).pipe(Effect.flip);
      expect(error).toEqual(new DaemonRuntimeError({ phase: "storage" }));
      expect(harness.events).toEqual(["worker", "engine"]);
    }),
  );

const blocksRegistrationAndSupervisesOutbound = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(
    makeHarness(fixture, "outbound", true),
  );
  const fiber = Effect.runFork(
    run(fixture, makeStore(fixture, false), harness),
  );
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    const registration = Effect.runFork(
      requireOperations(harness).register(fixture.registerRequest),
    );
    await awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    expect(
      Option.isNone(await Effect.runPromise(Fiber.poll(registration))),
    ).toBe(true);

    await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
    const registrationResult = await awaitStage(
      Fiber.join(registration),
      "registration",
    );
    const encodedLocalCard = await Effect.runPromise(
      Schema.encode(AgentCard)(fixture.localCard),
    );
    expect(registrationResult).toEqual({
      kind: "registered",
      agentCard: encodedLocalCard,
    });

    await Effect.runPromise(Deferred.succeed(harness.failure, undefined));
    const failure = await awaitStage(
      Effect.flip(Fiber.join(fiber)),
      "engine outbound supervision",
    );
    expect(failure).toEqual(EXPECTED_LISTENER_FAILURE);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

const receivesFirstDelivery = async (
  handler: HarnessMcpEventHandler,
): Promise<undefined> => {
  const reader = responseReader(
    await handler.fetch(makeListenRequest("listener-1")),
  );
  expect(await awaitFrame(reader, "first subscription acknowledgment")).toEqual(
    {
      jsonrpc: "2.0",
      method: SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
      params: {
        cursor: null,
        truncated: false,
        _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
      },
    },
  );
  expect(await awaitFrame(reader, "first message delivery")).toMatchObject({
    jsonrpc: "2.0",
    method: "notifications/events/event",
    params: {
      name: INBOX_PENDING_EVENT,
      data: { pendingCount: 1 },
      cursor: null,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
    },
  });
  await reader.cancel();
  return undefined;
};

const acknowledgeDuringReplacementDelivery = async (
  harness: RuntimeHarness,
  handler: HarnessMcpEventHandler,
  pending: EnginePendingMessage,
): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
  const readBarrier: ReadBarrier = {
    entered: await Effect.runPromise(Deferred.make<undefined>()),
    release: await Effect.runPromise(Deferred.make<undefined>()),
  };
  harness.delivery.readBarrier = readBarrier;
  const reader = responseReader(
    await handler.fetch(makeListenRequest("listener-2")),
  );
  await awaitFrame(reader, "replacement subscription acknowledgment");
  await awaitStage(
    Deferred.await(readBarrier.entered),
    "pending delivery read",
  );

  const acknowledgment = Effect.runFork(
    requireOperations(harness).acknowledgeDelivery(pending.deliveryToken),
  );
  await Effect.runPromise(Effect.yieldNow());
  await Effect.runPromise(Deferred.succeed(readBarrier.release, undefined));
  expect(
    await awaitFrame(reader, "replacement message delivery"),
  ).toMatchObject({
    jsonrpc: "2.0",
    method: "notifications/events/event",
    params: {
      name: INBOX_PENDING_EVENT,
      data: { pendingCount: 1 },
      cursor: null,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-2" },
    },
  });
  await awaitStage(Fiber.join(acknowledgment), "delivery acknowledgment");
  return reader;
};

/**
 * One pending read per pass: at activation with no subscriber, when the first
 * subscriber attaches, when it detaches, and when its replacement attaches.
 */
const READS_THROUGH_REPLACEMENT = 4;

const replaysUntilAcknowledged = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none"));
  const fiber = Effect.runFork(
    run(fixture, makeStore(fixture, true, harness.delivery), harness),
  );
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    expect(harness.delivery.reads).toBeGreaterThanOrEqual(1);
    expect(harness.delivery.acknowledgedTokens).toEqual([]);
    const handler = requireHandler(harness);

    await receivesFirstDelivery(handler);
    expect(
      (await Effect.runPromise(requireOperations(harness).readInbox({}))).items,
    ).toEqual([
      {
        deliveryToken: fixture.pending.deliveryToken,
        item: { kind: "multicast", message: fixture.pending.message },
      },
    ]);
    harness.delivery.events.length = 0;
    const secondReader = await acknowledgeDuringReplacementDelivery(
      harness,
      handler,
      fixture.pending,
    );
    expect(harness.delivery.acknowledgedTokens).toEqual([
      fixture.pending.deliveryToken,
    ]);
    expect(harness.delivery.events).toEqual(["delivery-ready", "acknowledged"]);
    expect(harness.delivery.reads).toBeGreaterThanOrEqual(
      READS_THROUGH_REPLACEMENT,
    );
    await secondReader.cancel();
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

describe("daemon runtime composition", () => {
  it(
    "fails startup when classified inbox persistence fails",
    failsWhenStartupProjectionCannotPersist,
  );
  it("opens the configured history export", opensConfiguredHistoryExport);
  it(
    "opens no history export when none is configured",
    opensNoHistoryExportByDefault,
  );
  it("waits for the active engine and supervises the Router worker", () =>
    blocksStartupAndSupervisesWorker());
  it("does not finish registration before engine activation", () =>
    blocksRegistrationAndSupervisesOutbound());
  it("publishes durable deliveries before completing acknowledgment", () =>
    replaysUntilAcknowledged());
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore repository defaults after the MCP lifecycle tests. */
