/** @file Focused daemon activation, supervision, and attention lifecycle tests. */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/server";
import {
  AgentCard,
  AgentSigningAuthority,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import {
  type Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Redacted,
  Schema,
} from "effect";
import { describe, expect, it } from "vitest";
import { ConversationId } from "../contract.js";
import {
  EngineOutboundError,
  type EndpointEngine,
  type EngineTurnSink,
} from "../endpoint/engine.js";
import {
  Membership,
  encodeCanonical,
  hashMembership,
} from "../endpoint/representation.js";
import {
  RouterWorkerTransportError,
  type RouterWorker,
  type RouterWorkerInput,
} from "../endpoint/router-worker.js";
import type {
  EndpointRecovery,
  EndpointStore,
  IdentityBinding,
} from "../endpoint/store.js";
import type { HarnessMcpSubscriptionHandler } from "../harness-mcp-subscription.js";
import { makeHarnessMcpHttpHandler } from "../harness-mcp-wire.js";
import {
  HARNESS_EVENTS_EXTENSION,
  HARNESS_TURN_READY_FILTER,
  HARNESS_TURN_READY_NOTIFICATION,
  makeReplyGrant,
  type HarnessTurnEvent,
} from "../harness-runtime.js";
import { managementRegisterRequestSchema } from "../management-runtime.js";
import type { DaemonBootstrap } from "./configuration.js";
import { type DaemonRuntimeDependencies, runDaemonRuntime } from "./runtime.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- The focused lifecycle tests drive the Promise-native MCP stream boundary. */

const privateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHsbmQdBGQFs1eXLEWxKDblLeG//B9s8WmWEMQHvw4f8
-----END PRIVATE KEY-----`;
const registryKeyRepresentation = {
  crv: "Ed25519",
  kty: "OKP",
  x: "y1j1FUgbqjCPeQVEnllv-2euwn_s9DeDkfEh3gk_OJ0",
} as const;
const firstCardRepresentation = {
  payload:
    "eyJhZ2VudElkIjoiYWd0X0FRRUJBUUVCQVFFQkFRRUJBUUVCQVEiLCJhZ2VudE5hbWUiOiJhZ2VudC1vbmUiLCJpc3N1ZWRBdCI6IjIwMjYtMDgtMTNUMDA6MDA6MDFaIiwia2luZCI6ImFnZW50Q2FyZCIsIm1vbHR6YXBWZXJzaW9uIjoiMjAyNi43MjkuMSIsInByaW5jaXBhbElkIjoicHJuX0N3c0xDd3NMQ3dzTEN3c0xDd3NMQ3ciLCJwdWJsaWNLZXkiOnsiY3J2IjoiRWQyNTUxOSIsImt0eSI6Ik9LUCIsIngiOiIzclVKOTJ0SVAwREU0ZWttRVQxem1lNlNJV1RwNUcwS2lGM1pqTC1Bb0tnIn19",
  signatures: [
    {
      protected:
        "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoidXJuOmlldGY6cGFyYW1zOm9hdXRoOmp3ay10aHVtYnByaW50OnNoYS0yNTY6c2RFN0NFOENLYVFvMDlSYzdYUEVXbVVNN3puOS00RmxZRzR5QlFhODQtNCIsInR5cCI6ImFwcGxpY2F0aW9uL3ZuZC5tb2x0emFwLmFnZW50LWNhcmQrandzIn0",
      signature:
        "7gbf_w3RQVDaiX99yl3XrPAlVUweI_3R8P89ZRqOAB1P6KMP8fK71Ey3QHxEwmo_qnoVnZLVBuZomdnlOFRZAw",
    },
  ],
} as const;
const secondCardRepresentation = {
  payload:
    "eyJhZ2VudElkIjoiYWd0X0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWciLCJhZ2VudE5hbWUiOiJhZ2VudC10d28iLCJpc3N1ZWRBdCI6IjIwMjYtMDgtMTNUMDA6MDA6MDJaIiwia2luZCI6ImFnZW50Q2FyZCIsIm1vbHR6YXBWZXJzaW9uIjoiMjAyNi43MjkuMSIsInByaW5jaXBhbElkIjoicHJuX0RBd01EQXdNREF3TURBd01EQXdNREEiLCJwdWJsaWNLZXkiOnsiY3J2IjoiRWQyNTUxOSIsImt0eSI6Ik9LUCIsIngiOiJwZ1liNXhZbW9UVXVKWTRHbktLQnltRnVGSGJuZXRLRG55Vm1uYkZBTU9zIn19",
  signatures: [
    {
      protected:
        "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoidXJuOmlldGY6cGFyYW1zOm9hdXRoOmp3ay10aHVtYnByaW50OnNoYS0yNTY6c2RFN0NFOENLYVFvMDlSYzdYUEVXbVVNN3puOS00RmxZRzR5QlFhODQtNCIsInR5cCI6ImFwcGxpY2F0aW9uL3ZuZC5tb2x0emFwLmFnZW50LWNhcmQrandzIn0",
      signature:
        "srmWhPubdYbD4O2t85NncbzdJcLKkiaKYd3ZZtSees0mGJh_AJblHAJiFpFeNmoxBsoJEWRLnwAZ6S6npQkUBg",
    },
  ],
} as const;

const CONVERSATION_ID = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000001",
);
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";

interface Fixture {
  readonly bootstrap: DaemonBootstrap;
  readonly localCard: VerifiedAgentCard;
  readonly remoteCard: VerifiedAgentCard;
  readonly membership: typeof Membership.Type;
  readonly canonicalMembership: Uint8Array;
  readonly membershipHash: string;
  readonly canonicalLocalCard: Uint8Array;
}

const makeFixture = Effect.gen(function* () {
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeyRepresentation,
  );
  const decodeCard = (representation: unknown) =>
    Schema.decodeUnknown(AgentCard)(representation).pipe(
      Effect.flatMap((agentCard) =>
        AgentCard.verify({ agentCard, registrySignerPublicKey }),
      ),
    );
  const localCard = yield* decodeCard(firstCardRepresentation);
  const remoteCard = yield* decodeCard(secondCardRepresentation);
  const signingAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey),
  );
  const membership = yield* Schema.decodeUnknown(Membership)({
    moltzapVersion: MOLTZAP_VERSION,
    kind: "membership",
    conversationId: CONVERSATION_ID,
    membershipEpoch: 0,
    members: [firstCardRepresentation, secondCardRepresentation],
  });
  const bootstrap: DaemonBootstrap = {
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
  };
  return {
    bootstrap,
    localCard,
    remoteCard,
    membership,
    canonicalMembership: yield* encodeCanonical(Membership, membership),
    membershipHash: yield* hashMembership(membership),
    canonicalLocalCard: yield* encodeCanonical(AgentCard, localCard),
  } satisfies Fixture;
});

const emptyRecovery = (): EndpointRecovery => ({
  identity: undefined,
  startIntents: [],
  memberships: [],
  anchors: [],
  positions: [],
  stagedRecords: [],
  evidence: [],
  certifiedRecords: [],
  stagedReanchors: [],
  consumedAttention: [],
});

const makeStore = (fixture: Fixture, active: boolean): EndpointStore => {
  let identity: IdentityBinding | undefined = active
    ? {
        agentId: fixture.localCard.agentId,
        canonicalAgentCard: fixture.canonicalLocalCard,
      }
    : undefined;
  const recover = (): EndpointRecovery => ({
    ...emptyRecovery(),
    identity,
    memberships: active
      ? [
          {
            conversationId: CONVERSATION_ID,
            membershipHash: fixture.membershipHash,
            canonicalMembership: fixture.canonicalMembership,
          },
        ]
      : [],
  });
  return {
    readIdentity: () => Effect.succeed(identity),
    bindIdentity: (candidate) =>
      Effect.sync(() => {
        const mutation = identity === undefined ? "inserted" : "existing";
        identity ??= candidate;
        return mutation;
      }),
    bindStartIntent: () => Effect.dieMessage("outside daemon runtime test"),
    putConversationFoundation: () =>
      Effect.dieMessage("outside daemon runtime test"),
    stageRecord: () => Effect.dieMessage("outside daemon runtime test"),
    mergeEvidence: () => Effect.dieMessage("outside daemon runtime test"),
    promoteRecord: () => Effect.dieMessage("outside daemon runtime test"),
    applyCatchUpRecord: () => Effect.dieMessage("outside daemon runtime test"),
    stageReanchor: () => Effect.dieMessage("outside daemon runtime test"),
    completeReanchor: () => Effect.dieMessage("outside daemon runtime test"),
    applyCatchUpReanchor: () =>
      Effect.dieMessage("outside daemon runtime test"),
    consumeAttention: () => Effect.dieMessage("outside daemon runtime test"),
    hasConsumedAttention: () => Effect.succeed(false),
    searchConversations: () =>
      Effect.succeed({ conversationIds: [], hasMore: false }),
    readConversation: () => Effect.succeed({ records: [], continuation: null }),
    releaseContinuation: () => Effect.void,
    recover: () => Effect.succeed(recover()),
  };
};

const makeServices = (fixture: Fixture) => {
  const registry: Context.Tag.Service<typeof Registry> = {
    register: () =>
      Effect.succeed({ kind: "registered", agentCard: fixture.localCard }),
    lookup: (request) => {
      const card =
        "agentId" in request && request.agentId === fixture.remoteCard.agentId
          ? fixture.remoteCard
          : fixture.localCard;
      return Effect.succeed({ kind: "found", agentCard: card });
    },
    list: () =>
      Effect.succeed({
        kind: "page",
        agentCards: [fixture.localCard, fixture.remoteCard],
        hasMore: false,
      }),
  };
  const router: Context.Tag.Service<typeof Router> = {
    send: () => Effect.dieMessage("worker factory owns sends in this test"),
    poll: () => Effect.dieMessage("worker factory owns polls in this test"),
  };
  return { registry, router };
};

interface RuntimeHarness {
  readonly dependencies: DaemonRuntimeDependencies;
  readonly engineEntered: Deferred.Deferred<void>;
  readonly engineRelease: Deferred.Deferred<void>;
  readonly listenerReady: Deferred.Deferred<void>;
  readonly listenerDetached: Deferred.Deferred<void>;
  readonly failure: Deferred.Deferred<void>;
  readonly sinkReady: Deferred.Deferred<EngineTurnSink>;
  readonly startCalled: Deferred.Deferred<void>;
  readonly events: string[];
  readonly pinned: RouterWorkerInput[];
  readonly getHandler: () =>
    | HarnessMcpSubscriptionHandler<HarnessTurnEvent>
    | undefined;
  readonly getOperations: () =>
    | Parameters<typeof makeHarnessMcpHttpHandler>[0]["operations"]
    | undefined;
}

const makeHarness = (
  background: "worker" | "outbound",
  blockEngine = false,
): Effect.Effect<RuntimeHarness> =>
  Effect.gen(function* () {
    const engineEntered = yield* Deferred.make<void>();
    const engineRelease = yield* Deferred.make<void>();
    const listenerReady = yield* Deferred.make<void>();
    const listenerDetached = yield* Deferred.make<void>();
    const failure = yield* Deferred.make<void>();
    const sinkReady = yield* Deferred.make<EngineTurnSink>();
    const startCalled = yield* Deferred.make<void>();
    const events: string[] = [];
    const pinned: RouterWorkerInput[] = [];
    let handler: HarnessMcpSubscriptionHandler<HarnessTurnEvent> | undefined;
    let operations:
      | Parameters<typeof makeHarnessMcpHttpHandler>[0]["operations"]
      | undefined;

    const failWorkerWhenReleased = Deferred.await(failure).pipe(
      Effect.zipRight(Effect.fail(new RouterWorkerTransportError())),
    );
    const failOutboundWhenReleased = Deferred.await(failure).pipe(
      Effect.zipRight(
        Effect.fail(new EngineOutboundError({ reason: "durability" })),
      ),
    );
    const worker: RouterWorker = {
      currentAnchor: Effect.dieMessage("outside daemon runtime test"),
      pollOnce: Effect.dieMessage("outside daemon runtime test"),
      run: background === "worker" ? failWorkerWhenReleased : Effect.never,
      send: () => Effect.dieMessage("outside daemon runtime test"),
    };
    const engine: EndpointEngine = {
      start: () => Deferred.succeed(startCalled, undefined).pipe(Effect.asVoid),
      reply: () => Effect.void,
      acceptRouterIngress: () => Effect.succeed("ignored"),
      acceptRecoveryIngress: () => Effect.succeed("ignored"),
      recoverCertifiedHistory: () => Effect.void,
      drainOutbound: Effect.void,
      runOutbound:
        background === "outbound" ? failOutboundWhenReleased : Effect.never,
      abandonVolatileFolds: () => Effect.void,
      acquireTurnSink: (sink) =>
        Effect.acquireRelease(
          Deferred.succeed(sinkReady, sink).pipe(
            Effect.as({
              detach: Deferred.succeed(listenerDetached, undefined).pipe(
                Effect.asVoid,
              ),
            }),
          ),
          (listener) => listener.detach,
        ),
      deliverTurn: () => Effect.void,
    };
    const dependencies: DaemonRuntimeDependencies = {
      makeWorker: (input) =>
        Effect.sync(() => {
          events.push("worker");
          pinned.push(input);
          return worker;
        }),
      makeEngine: () =>
        Effect.gen(function* () {
          events.push("engine");
          yield* Deferred.succeed(engineEntered, undefined);
          if (blockEngine) {
            yield* Deferred.await(engineRelease);
          }
          return engine;
        }),
      makeHandler: (options) =>
        Effect.sync(() => {
          events.push("handler");
          operations = options.operations;
        }).pipe(Effect.zipRight(makeHarnessMcpHttpHandler(options))),
      acquireListener: (input) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push("listener");
            handler = input.handler;
          }).pipe(Effect.zipRight(Deferred.succeed(listenerReady, undefined))),
          () =>
            Effect.tryPromise({
              try: () => input.handler.close(),
              catch: () => undefined,
            }).pipe(Effect.ignore),
        ).pipe(Effect.asVoid),
    };
    return {
      dependencies,
      engineEntered,
      engineRelease,
      listenerReady,
      listenerDetached,
      failure,
      sinkReady,
      startCalled,
      events,
      pinned,
      getHandler: () => handler,
      getOperations: () => operations,
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

const makeListenRequest = (): Request =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": SUBSCRIPTIONS_LISTEN_METHOD,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "daemon-listener",
      method: SUBSCRIPTIONS_LISTEN_METHOD,
      params: {
        notifications: { [HARNESS_TURN_READY_FILTER]: true },
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: "daemon-test", version: "1.0.0" },
          [CLIENT_CAPABILITIES_META_KEY]: {
            extensions: { [HARNESS_EVENTS_EXTENSION]: {} },
          },
        },
      },
    }),
  });

const readFrame = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Readonly<Record<string, unknown>>> => {
  const result = await reader.read();
  if (result.done || result.value === undefined) {
    throw new Error("expected complete SSE frame");
  }
  const frame = new TextDecoder().decode(result.value);
  return JSON.parse(frame.slice("data: ".length, -"\n\n".length));
};

const awaitStage = <A, E>(
  effect: Effect.Effect<A, E>,
  stage: string,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.timeoutFail({
        duration: "1 second",
        onTimeout: () => new Error(`timed out awaiting ${stage}`),
      }),
    ),
  );

const assertActiveStartup = async (background: "worker" | "outbound") => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(background));
  const fiber = Effect.runFork(run(fixture, makeStore(fixture, true), harness));
  await Effect.runPromise(Deferred.await(harness.listenerReady));

  expect(harness.events).toEqual(["worker", "engine", "handler", "listener"]);
  expect(
    harness.pinned[0]?.pinnedSenderCards.map((card) => card.agentId),
  ).toEqual([fixture.localCard.agentId, fixture.remoteCard.agentId]);

  await Effect.runPromise(Deferred.succeed(harness.failure, undefined));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  expect(Exit.isFailure(exit)).toBe(true);
};

const assertRegistrationBarrier = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness("worker", true));
  const fiber = Effect.runFork(
    run(fixture, makeStore(fixture, false), harness),
  );
  await awaitStage(Deferred.await(harness.listenerReady), "listener");
  const operations = harness.getOperations();
  expect(operations).toBeDefined();
  if (operations === undefined) {
    throw new Error("missing composed operations");
  }
  const inactive = await awaitStage(
    Effect.flip(
      operations.start({
        conversationId: CONVERSATION_ID,
        peers: [fixture.remoteCard.agentName],
        content: [{ type: "text", text: "hello" }],
      }),
    ),
    "inactive START",
  );
  expect(inactive.reason).toBe("not-registered");

  const request = Schema.decodeUnknownSync(managementRegisterRequestSchema)({
    operationId: "opn_AAAAAAAAAAAAAAAAAAAAAA",
    principalId: "prn_CwsLCwsLCwsLCwsLCwsLCw",
    agentName: "agent-one",
  });
  const registration = Effect.runFork(operations.register(request));
  await awaitStage(Deferred.await(harness.engineEntered), "engine acquisition");
  expect(Option.isNone(await Effect.runPromise(Fiber.poll(registration)))).toBe(
    true,
  );
  await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
  expect(
    (await awaitStage(Fiber.join(registration), "registration")).kind,
  ).toBe("registered");
  await awaitStage(
    operations.start({
      conversationId: CONVERSATION_ID,
      peers: [fixture.remoteCard.agentName],
      content: [{ type: "text", text: "hello" }],
    }),
    "active START",
  );
  await awaitStage(Deferred.await(harness.startCalled), "START delegation");

  await Effect.runPromise(Deferred.succeed(harness.failure, undefined));
  await awaitStage(Fiber.await(fiber), "supervised shutdown");
};

const assertSubscriptionLifecycle = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness("worker"));
  const fiber = Effect.runFork(run(fixture, makeStore(fixture, true), harness));
  await Effect.runPromise(Deferred.await(harness.listenerReady));
  expect(
    Option.isNone(await Effect.runPromise(Deferred.poll(harness.sinkReady))),
  ).toBe(true);
  const handler = harness.getHandler();
  if (handler === undefined) {
    throw new Error("missing MCP handler");
  }
  const response = await handler.fetch(makeListenRequest());
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("missing retained response stream");
  }
  await readFrame(reader);
  const sink = await Effect.runPromise(Deferred.await(harness.sinkReady));
  const replyGrant = await Effect.runPromise(makeReplyGrant());
  await Effect.runPromise(
    sink.write({
      conversationId: CONVERSATION_ID,
      peers: [fixture.localCard],
      author: fixture.remoteCard,
      content: [{ type: "text", text: "certified" }],
      replyGrant,
    }),
  );
  expect(await readFrame(reader)).toEqual({
    jsonrpc: "2.0",
    method: HARNESS_TURN_READY_NOTIFICATION,
    params: {
      conversationId: CONVERSATION_ID,
      peers: [firstCardRepresentation],
      author: secondCardRepresentation,
      content: [{ type: "text", text: "certified" }],
      replyGrant,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "daemon-listener" },
    },
  });
  await reader.cancel();
  await Effect.runPromise(Deferred.await(harness.listenerDetached));

  await Effect.runPromise(Deferred.succeed(harness.failure, undefined));
  await Effect.runPromise(Fiber.await(fiber));
};

describe("daemon runtime composition", () => {
  it("recovers pinned cards and supervises the Router worker", () =>
    assertActiveStartup("worker"));
  it("supervises the engine outbound pump", () =>
    assertActiveStartup("outbound"));
  it("does not return registration before the active engine exists", () =>
    assertRegistrationBarrier());
  it("owns attention only for the exact live turn subscription", () =>
    assertSubscriptionLifecycle());
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore repository defaults after the MCP lifecycle tests. */
