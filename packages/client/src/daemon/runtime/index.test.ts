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
import type { HarnessMcpSubscriptionHandler } from "../../harness-mcp-subscription.js";
import type { DaemonBootstrap } from "../configuration.js";
import { DeliveryAcknowledgeError, InboundMessage } from "../../contract.js";
import {
  type EndpointEngine,
  EngineOutboundError,
  type EnginePendingMessage,
} from "../../endpoint/engine.js";
import { encodeCanonical } from "../../endpoint/representation.js";
import {
  type RouterWorker,
  type RouterWorkerInput,
  RouterWorkerTransportError,
} from "../../endpoint/router-worker/index.js";
import {
  DeliveryToken,
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
  type IdentityBinding,
} from "../../endpoint/store.js";
import {
  HARNESS_EVENTS_EXTENSION,
  HARNESS_MESSAGE_READY_FILTER,
  HARNESS_MESSAGE_READY_NOTIFICATION,
  type HarnessMessageReadyEvent,
} from "../../harness-mcp-contract.js";
import {
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

const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";
const SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION =
  "notifications/subscriptions/acknowledged";
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
  handler?: HarnessMcpSubscriptionHandler<HarnessMessageReadyEvent>;
  operations?: HarnessMcpOperations;
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
  readonly getHandler: () =>
    | HarnessMcpSubscriptionHandler<HarnessMessageReadyEvent>
    | undefined;
  readonly getOperations: () => HarnessMcpOperations | undefined;
  readonly getWorkerOutbox: () => RouterWorkerInput["outbox"] | undefined;
}

type BackgroundFailure = "none" | "outbound" | "worker";

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
    admissionCredential: Redacted.make("bootstrap-token="),
  });
  const registerRequest = yield* Schema.decodeUnknown(
    managementRegisterRequestSchema,
  )({
    operationId: identifier("opn_", 3),
    principalId: localCard.principalId,
    agentName: localCard.agentName,
  });
  const deliveryToken = yield* Schema.decodeUnknown(DeliveryToken)(
    digest("dlv_", 4),
  );
  const message = yield* Schema.decodeUnknown(InboundMessage)({
    kind: "direct",
    postId: digest("pst_", 5),
    address: "agent:bob",
    sender: "agent:bob",
    content: [{ type: "text", text: "certified" }],
  });
  return {
    bootstrap,
    localCard,
    canonicalLocalCard: yield* encodeCanonical(AgentCard, localCard),
    registerRequest,
    pending: { deliveryToken, message },
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

function makeStore(fixture: Fixture, active: boolean): EndpointStore {
  let identity: IdentityBinding | undefined = active
    ? {
        agentId: fixture.localCard.agentId,
        canonicalAgentCard: fixture.canonicalLocalCard,
      }
    : undefined;
  return {
    ...inactiveStoreOperations,
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

const closeHandler = (
  handler: HarnessMcpSubscriptionHandler<HarnessMessageReadyEvent>,
) =>
  Effect.tryPromise({
    try: () => handler.close(),
    catch: () => new Error("failed to close test MCP handler"),
  }).pipe(Effect.ignore);

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
  };
}

function makeWorker(
  background: BackgroundFailure,
  signals: HarnessSignals,
): RouterWorker {
  const failure = Deferred.await(signals.failure).pipe(
    Effect.zipRight(Effect.fail(new RouterWorkerTransportError())),
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
      Effect.fail(new EngineOutboundError({ reason: "network" })),
    ),
  );
  return {
    send: () => Effect.void,
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
    const observations: HarnessObservations = { events: [] };
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
      getHandler: () => observations.handler,
      getOperations: () => observations.operations,
      getWorkerOutbox: () => observations.workerOutbox,
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
      "mcp-method": SUBSCRIPTIONS_LISTEN_METHOD,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: SUBSCRIPTIONS_LISTEN_METHOD,
      params: {
        notifications: { [HARNESS_MESSAGE_READY_FILTER]: true },
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: {
            name: "daemon-runtime-test-client",
            version: "1.0.0",
          },
          [CLIENT_CAPABILITIES_META_KEY]: {
            experimental: { [HARNESS_EVENTS_EXTENSION]: {} },
          },
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

const readFrame = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown> => {
  const result = await reader.read();
  if (result.done || result.value === undefined) {
    throw new Error("expected a complete SSE data frame");
  }
  const frame = new TextDecoder().decode(result.value);
  if (!frame.startsWith("data: ") || !frame.endsWith("\n\n")) {
    throw new Error("expected an SSE data frame");
  }
  return JSON.parse(frame.slice("data: ".length, -"\n\n".length));
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

function requireHandler(
  harness: RuntimeHarness,
): HarnessMcpSubscriptionHandler<HarnessMessageReadyEvent> {
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
  handler: HarnessMcpSubscriptionHandler<HarnessMessageReadyEvent>,
  pending: EnginePendingMessage,
): Promise<undefined> => {
  const reader = responseReader(
    await handler.fetch(makeListenRequest("listener-1")),
  );
  expect(await awaitFrame(reader, "first subscription acknowledgment")).toEqual(
    {
      jsonrpc: "2.0",
      method: SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
      params: {
        notifications: { [HARNESS_MESSAGE_READY_FILTER]: true },
        _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
      },
    },
  );
  expect(await awaitFrame(reader, "first message delivery")).toEqual({
    jsonrpc: "2.0",
    method: HARNESS_MESSAGE_READY_NOTIFICATION,
    params: {
      ...pending,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
    },
  });
  await reader.cancel();
  return undefined;
};

const acknowledgeDuringReplacementDelivery = async (
  harness: RuntimeHarness,
  handler: HarnessMcpSubscriptionHandler<HarnessMessageReadyEvent>,
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
  expect(await awaitFrame(reader, "replacement message delivery")).toEqual({
    jsonrpc: "2.0",
    method: HARNESS_MESSAGE_READY_NOTIFICATION,
    params: {
      ...pending,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-2" },
    },
  });
  await awaitStage(Fiber.join(acknowledgment), "delivery acknowledgment");
  return reader;
};

const replaysUntilAcknowledged = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none"));
  const fiber = Effect.runFork(run(fixture, makeStore(fixture, true), harness));
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    expect(harness.delivery.reads).toBe(0);
    const handler = requireHandler(harness);

    await receivesFirstDelivery(handler, fixture.pending);
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
    expect(harness.delivery.reads).toBe(2);
    await secondReader.cancel();
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

describe("daemon runtime composition", () => {
  it("waits for the active engine and supervises the Router worker", () =>
    blocksStartupAndSupervisesWorker());
  it("does not finish registration before engine activation", () =>
    blocksRegistrationAndSupervisesOutbound());
  it("publishes durable deliveries before completing acknowledgment", () =>
    replaysUntilAcknowledged());
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore repository defaults after the MCP lifecycle tests. */
