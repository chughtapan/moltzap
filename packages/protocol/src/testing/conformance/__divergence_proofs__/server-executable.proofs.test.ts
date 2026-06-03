import { describe, expect, it } from "vitest";
import { Effect, Either, Exit, Ref, Scope } from "effect";
import * as fc from "fast-check";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import type { RequestFrame, ResponseFrame } from "../../../transport/index.js";
import { responseFrame } from "../../index.js";
import {
  TaskConversationArchive,
  TaskConversationCreate,
  TaskConversationUnarchive,
  MessagesSend,
  TaskAddParticipant,
  TaskClose,
  TaskRequest,
} from "../../../task/index.js";
import {
  decodeFrame,
  encodeFrame,
  isRequestFrame,
  isResponseFrame,
} from "../_shared/frame-mutator.js";
import type {
  ConformanceRunContext,
  RealServerHandle,
} from "../_shared/runner.js";
import { registerArchiveLifecycle } from "../task/archive-lifecycle.js";
import { registerConversationLifecycle } from "../task/conversation-lifecycle.js";
import { registerTaskCloseLifecycle } from "../task/task-close-lifecycle.js";
import { registerConnectBroadcast } from "../network/presence-connect-broadcast.js";
import { registerDisconnectBroadcast } from "../network/presence-disconnect-broadcast.js";
import { registerMultiSubscriberFanOut } from "../network/presence-multi-subscriber-fan-out.js";
import { registerReconnectStorm } from "../network/presence-reconnect-storm.js";
import { registerSameStateNoDoubleFire } from "../network/presence-same-state-no-double-fire.js";
import { registerSubscribeAfterConnect } from "../network/presence-subscribe-after-connect.js";
import { registerSpuriousAppCallbackFrameHandling } from "../app/spurious-app-callback-frame.js";
import {
  collectProperties,
  type PropertyFailure,
} from "../_shared/registry.js";
import { registerAuthorityPositive } from "../identity/authority-positive.js";
import { registerAuthorityNegative } from "../identity/authority-negative.js";
import { registerIdempotence } from "../app/idempotence.js";
import { registerRequestIdUniqueness } from "../transport/request-id-uniqueness.js";
import { registerRequestWellFormedness } from "../transport/request-well-formedness.js";
import { registerRpcMapCoverage } from "../transport/rpc-map-coverage.js";
import {
  expectAssertionFailure,
  expectInvariant,
  runExpectingFailure,
} from "./executable-proof-helpers.js";

import { AgentsList } from "../../../identity/index.js";
import { Connect } from "../../../network/index.js";
import { ContactsList } from "../../../identity/index.js";
import { TaskList } from "../../../task/index.js";
import { PresenceSubscribe } from "../../../network/index.js";

type BadServerBehavior =
  | "allow-unauthenticated"
  | "duplicate-response-id"
  | "drop-contacts-list"
  | "drop-sampled-response"
  | "reject-authorized"
  | "drift-idempotent-result"
  | "conversation-missing-created-event"
  | "archive-missing-event"
  | "task-close-missing-event"
  | "presence-silent"
  | "presence-stale-snapshot"
  | "reply-to-spurious-response";

type BadServerWriter = (raw: string) => Effect.Effect<void, unknown>;
type ProofExpectation = "assertion" | "invariant";

interface ServerProofCase {
  readonly title: string;
  readonly register: (ctx: ConformanceRunContext) => void;
  readonly behavior: BadServerBehavior;
  readonly propertyName: string;
  readonly expectation: ProofExpectation;
  readonly timeoutMs?: number;
}

const REQUEST_WELL_FORMEDNESS_PROOF_TIMEOUT_MS = 12_000;
const SERVER_PROOF_TIMEOUT_MS = 10_000;

const SERVER_PROOF_CASES: ReadonlyArray<ServerProofCase> = [
  {
    title:
      "registerAuthorityNegative fails when pre-handshake RPCs return success",
    register: registerAuthorityNegative,
    behavior: "allow-unauthenticated",
    propertyName: "authority-negative",
    expectation: "invariant",
  },
  {
    title: "registerAuthorityPositive fails when an authorized RPC is denied",
    register: registerAuthorityPositive,
    behavior: "reject-authorized",
    propertyName: "authority-positive",
    expectation: "invariant",
  },
  {
    title: "registerRequestIdUniqueness fails when responses duplicate an id",
    register: registerRequestIdUniqueness,
    behavior: "duplicate-response-id",
    propertyName: "request-id-uniqueness",
    expectation: "assertion",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
  {
    title: "registerIdempotence fails when list results drift across replays",
    register: registerIdempotence,
    behavior: "drift-idempotent-result",
    propertyName: "idempotence",
    expectation: "invariant",
  },
  {
    title:
      "registerRequestWellFormedness fails when sampled calls receive no reply",
    register: registerRequestWellFormedness,
    behavior: "drop-sampled-response",
    propertyName: "request-well-formedness",
    expectation: "assertion",
    timeoutMs: REQUEST_WELL_FORMEDNESS_PROOF_TIMEOUT_MS,
  },
  {
    title: "registerRpcMapCoverage fails when a sampled method never responds",
    register: registerRpcMapCoverage,
    behavior: "drop-contacts-list",
    propertyName: "rpc-map-coverage",
    expectation: "invariant",
  },
  {
    title:
      "registerArchiveLifecycle fails when archive does not broadcast lifecycle",
    register: registerArchiveLifecycle,
    behavior: "archive-missing-event",
    propertyName: "archive-lifecycle",
    expectation: "invariant",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerConversationLifecycle fails when create does not broadcast lifecycle",
    register: registerConversationLifecycle,
    behavior: "conversation-missing-created-event",
    propertyName: "conversation-lifecycle",
    expectation: "invariant",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerTaskCloseLifecycle fails when close does not broadcast lifecycle",
    register: registerTaskCloseLifecycle,
    behavior: "task-close-missing-event",
    propertyName: "task-close-lifecycle",
    expectation: "invariant",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerConnectBroadcast fails when network/connect does not broadcast presence/changed",
    register: registerConnectBroadcast,
    behavior: "presence-silent",
    propertyName: "connect-broadcast",
    expectation: "invariant",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDisconnectBroadcast fails when ws-close does not broadcast presence/changed",
    register: registerDisconnectBroadcast,
    behavior: "presence-silent",
    propertyName: "disconnect-broadcast",
    expectation: "invariant",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerReconnectStorm fails when no presence/changed events fire on connect/disconnect",
    register: registerReconnectStorm,
    behavior: "presence-silent",
    propertyName: "reconnect-storm",
    expectation: "invariant",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerSameStateNoDoubleFire fails when no presence/changed event fires on initial connect",
    register: registerSameStateNoDoubleFire,
    behavior: "presence-silent",
    propertyName: "same-state-no-double-fire",
    expectation: "invariant",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerMultiSubscriberFanOut fails when subscribers receive no presence/changed event",
    register: registerMultiSubscriberFanOut,
    behavior: "presence-silent",
    propertyName: "multi-subscriber-fan-out",
    expectation: "invariant",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerSubscribeAfterConnect fails when subscribe snapshot reports stale offline for a connected agent",
    register: registerSubscribeAfterConnect,
    behavior: "presence-stale-snapshot",
    propertyName: "subscribe-after-connect",
    expectation: "invariant",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerSpuriousAppCallbackFrameHandling fails when the server replies to a stray response",
    register: registerSpuriousAppCallbackFrameHandling,
    behavior: "reply-to-spurious-response",
    propertyName: "spurious-app-callback-frame-handling",
    expectation: "assertion",
    timeoutMs: SERVER_PROOF_TIMEOUT_MS,
  },
];

describe("server-side conformance executable divergence proofs", () => {
  it("proof matrix maps every case to one property name", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SERVER_PROOF_CASES),
        hasUniquePropertyName,
      ),
    );
    expect(SERVER_PROOF_CASES).toHaveLength(16);
  });

  for (const proof of SERVER_PROOF_CASES) {
    it(
      proof.title,
      () => {
        expect.hasAssertions();
        return Effect.runPromise(runServerProofCase(proof));
      },
      proof.timeoutMs,
    );
  }
});

const hasUniquePropertyName = (proof: ServerProofCase): boolean =>
  SERVER_PROOF_CASES.filter(
    (candidate) => candidate.propertyName === proof.propertyName,
  ).length === 1;

const runServerProofCase = (proof: ServerProofCase): Effect.Effect<void> =>
  Effect.gen(function* () {
    const failure = yield* runSingleServerProof(proof.register, {
      behavior: proof.behavior,
    });
    if (proof.expectation === "assertion") {
      expectAssertionFailure(failure, proof.propertyName);
      return;
    }
    expectInvariant(failure, proof.propertyName);
  });

function runSingleServerProof(
  register: (ctx: ConformanceRunContext) => void,
  opts: { readonly behavior: BadServerBehavior },
): Effect.Effect<PropertyFailure> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* makeBadServerContext(opts.behavior);
          register(ctx);
          const properties = collectProperties(ctx);
          if (properties.length !== 1) {
            return yield* Effect.die(
              new Error(`expected one property, got ${properties.length}`),
            );
          }
          return yield* runExpectingFailure(properties[0]!);
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
    if (Exit.isFailure(exit)) {
      return yield* Effect.die(
        new Error(`proof harness defect: ${exit.cause.toString()}`),
      );
    }
    return exit.value;
  });
}

function makeBadServerContext(
  behavior: BadServerBehavior,
): Effect.Effect<
  ConformanceRunContext,
  never,
  Scope.Scope | HttpServer.HttpServer
> {
  return Effect.gen(function* () {
    const httpHandle = yield* makeRegistrationHttpServer;
    const wsHandle = yield* makeBadWebSocketServer(behavior);
    const realServer: RealServerHandle = {
      baseUrl: httpHandle.baseUrl,
      wsUrl: wsHandle.wsUrl,
      close: Effect.void,
    };
    return {
      realServer,
      toxiproxy: null,
      opts: {
        tiers: ["A", "B", "C", "E"],
        realServer: Effect.succeed(realServer),
        numRuns: 1,
      },
      seed: 42,
    } satisfies ConformanceRunContext;
  });
}

const BAD_SERVER_AGENT_UUID_PREFIX = "00000000-0000-4000-8000-";
const BAD_SERVER_AGENT_UUID_NODE_LEN = 12;
const BAD_SERVER_AGENT_UUID_RADIX = 16;
const DUPLICATE_RESPONSE_ID = "bad-server-duplicate-response-id";

function badServerAgentId(counter: number): string {
  return `${BAD_SERVER_AGENT_UUID_PREFIX}${counter
    .toString(BAD_SERVER_AGENT_UUID_RADIX)
    .padStart(BAD_SERVER_AGENT_UUID_NODE_LEN, "0")}`;
}

const makeRegistrationHttpServer: Effect.Effect<
  { readonly baseUrl: string },
  never,
  Scope.Scope | HttpServer.HttpServer
> = Effect.gen(function* () {
  let counter = 0;
  const registerRoute = HttpRouter.post(
    "/api/v1/auth/register",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* request.json.pipe(Effect.ignore);
      counter += 1;
      return HttpServerResponse.unsafeJson({
        agentId: badServerAgentId(counter),
        apiKey: `bad-server-key-${counter}`,
        claimUrl: `http://127.0.0.1/claim/${counter}`,
        claimToken: `claim-${counter}`,
      });
    }),
  );
  yield* HttpServer.serveEffect(HttpRouter.empty.pipe(registerRoute));
  const address = yield* HttpServer.addressWith((addr) => Effect.succeed(addr));
  if (address._tag !== "TcpAddress") {
    return yield* Effect.die(
      new Error(`expected TcpAddress, got ${address._tag}`),
    );
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}).pipe(Effect.orDie);

function makeBadWebSocketServer(
  behavior: BadServerBehavior,
): Effect.Effect<{ readonly wsUrl: string }, never, Scope.Scope> {
  return Effect.gen(function* () {
    const requestCounter = yield* Ref.make(0);
    const server = yield* NodeSocketServer.makeWebSocket({
      port: 0,
      host: "127.0.0.1",
    }).pipe(Effect.orDie);

    yield* Effect.forkScoped(
      server
        .run((socket) =>
          Effect.gen(function* () {
            const writer = yield* socket.writer;
            yield* socket.runRaw(
              badServerRawDataHandler(writer, requestCounter, behavior),
            );
          }),
        )
        .pipe(Effect.ignore),
    );

    const address = server.address;
    if (address._tag !== "TcpAddress") {
      return yield* Effect.die(
        new Error(`expected TcpAddress, got ${address._tag}`),
      );
    }
    return { wsUrl: `ws://${address.hostname}:${address.port}` };
  });
}

const badServerRawDataHandler =
  (
    writer: BadServerWriter,
    requestCounter: Ref.Ref<number>,
    behavior: BadServerBehavior,
  ) =>
  (data: string | Uint8Array): Effect.Effect<void> =>
    handleBadServerRawData(data, writer, requestCounter, behavior);

function rawSocketDataToString(data: string | Uint8Array): string {
  return typeof data === "string"
    ? data
    : new TextDecoder("utf-8").decode(data);
}

const writeBare = (
  writer: BadServerWriter,
  frame: string,
): Effect.Effect<void> => writer(frame).pipe(Effect.orDie);

function handleBadServerRawData(
  data: string | Uint8Array,
  writer: BadServerWriter,
  requestCounter: Ref.Ref<number>,
  behavior: BadServerBehavior,
): Effect.Effect<void> {
  const raw = rawSocketDataToString(data);
  return Effect.gen(function* () {
    const decoded = yield* Effect.either(decodeFrame(raw, "inbound"));
    const frame = Either.getOrNull(decoded);
    if (frame === null) return;
    if (isResponseFrame(frame)) {
      return yield* handleBadServerResponseFrame(frame, writer, behavior);
    }
    if (!isRequestFrame(frame)) return;
    const ordinal = yield* Ref.updateAndGet(requestCounter, (n) => n + 1);
    const response = makeBadResponse(frame, behavior, ordinal);
    if (response === null) return;
    yield* writeBare(writer, encodeFrame(response));
  });
}

function handleBadServerResponseFrame(
  response: ResponseFrame,
  writer: BadServerWriter,
  behavior: BadServerBehavior,
): Effect.Effect<void> {
  if (behavior !== "reply-to-spurious-response") return Effect.void;
  return writeBare(
    writer,
    encodeFrame(
      responseFrame(response.id, {
        error: {
          _tag: "InvalidParamsError",
          message: "bad server replied to a stray response frame",
        },
      }),
    ),
  );
}

function makeBadResponse(
  request: RequestFrame,
  behavior: BadServerBehavior,
  ordinal: number,
): ResponseFrame | null {
  if (shouldDropBadResponse(request, behavior)) {
    return null;
  }
  if (shouldRejectBadResponse(request, behavior)) {
    return responseFrame(request.id, {
      error: {
        _tag: "InternalError",
        message: "bad server rejects an authorized call",
      },
    });
  }
  const responseId =
    behavior === "duplicate-response-id" && request.method === TaskList.name
      ? DUPLICATE_RESPONSE_ID
      : request.id;
  return responseFrame(responseId, {
    result: makeBadResult(request, behavior, ordinal),
  });
}

const shouldDropBadResponse = (
  request: RequestFrame,
  behavior: BadServerBehavior,
): boolean =>
  (behavior === "drop-contacts-list" && request.method === ContactsList.name) ||
  behavior === "drop-sampled-response";

const shouldRejectBadResponse = (
  request: RequestFrame,
  behavior: BadServerBehavior,
): boolean =>
  behavior === "reject-authorized" && request.method === TaskList.name;

function makeBadResult(
  request: RequestFrame,
  behavior: BadServerBehavior,
  ordinal: number,
): unknown {
  if (behavior === "archive-missing-event") {
    return makeArchiveLifecycleBadResult(request);
  }
  if (behavior === "conversation-missing-created-event") {
    return makeConversationLifecycleBadResult(request);
  }
  if (behavior === "task-close-missing-event") {
    return makeTaskCloseLifecycleBadResult(request);
  }
  const presenceResult = makePresenceBadResult(request, behavior);
  if (presenceResult !== undefined) {
    return presenceResult;
  }
  switch (request.method) {
    case Connect.name:
      return {};
    case AgentsList.name:
      return makeAgentsListBadResult(behavior, ordinal);
    case TaskList.name:
      return makeTaskListBadResult(behavior, ordinal);
    default:
      return {};
  }
}

function makeAgentsListBadResult(
  behavior: BadServerBehavior,
  ordinal: number,
): unknown {
  if (behavior !== "drift-idempotent-result") {
    return { agents: [] };
  }
  return {
    agents: [{ id: `agent-${ordinal}`, status: "active" }],
  };
}

function makeTaskListBadResult(
  behavior: BadServerBehavior,
  ordinal: number,
): unknown {
  if (behavior !== "drift-idempotent-result") {
    return { tasks: [] };
  }
  return {
    tasks: [
      {
        id: `00000000-0000-4000-8000-${ordinal
          .toString(BAD_SERVER_AGENT_UUID_RADIX)
          .padStart(BAD_SERVER_AGENT_UUID_NODE_LEN, "0")}`,
        appId: "bad-server-app",
        initiatorAgentId: "00000000-0000-4000-8000-000000000001",
        status: "active",
        startedAt: null,
        endedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function makePresenceBadResult(
  request: RequestFrame,
  behavior: BadServerBehavior,
): unknown | undefined {
  if (
    behavior !== "presence-silent" &&
    behavior !== "presence-stale-snapshot"
  ) {
    return undefined;
  }
  if (request.method === PresenceSubscribe.name) {
    const params = request.params as { agentIds?: ReadonlyArray<unknown> };
    const ids = Array.isArray(params.agentIds) ? params.agentIds : [];
    return {
      statuses: ids
        .filter((id): id is string => typeof id === "string")
        .map((agentId) => ({ agentId, status: "offline" as const })),
    };
  }
  return undefined;
}

function makeConversationLifecycleBadResult(request: RequestFrame): unknown {
  if (request.method === TaskConversationCreate.name) {
    return {
      conversation: {
        id: "00000000-0000-4000-8000-000000000101",
        name: "bad lifecycle",
        createdBy: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
  }
  if (
    request.method === TaskConversationArchive.name ||
    request.method === TaskConversationUnarchive.name
  ) {
    return {};
  }
  if (request.method === MessagesSend.name) {
    const params = request.params as { conversationId?: unknown };
    return {
      message: {
        id: "00000000-0000-4000-8000-000000000102",
        conversationId:
          typeof params.conversationId === "string"
            ? params.conversationId
            : "00000000-0000-4000-8000-000000000101",
      },
    };
  }
  return {};
}

function makeArchiveLifecycleBadResult(request: RequestFrame): unknown {
  if (request.method === TaskConversationCreate.name) {
    return {
      conversation: {
        id: "00000000-0000-4000-8000-000000000001",
      },
    };
  }
  if (
    request.method === TaskConversationArchive.name ||
    request.method === TaskConversationUnarchive.name
  ) {
    return {};
  }
  if (request.method === MessagesSend.name) {
    const params = request.params as { conversationId?: unknown };
    return {
      message: {
        id: "00000000-0000-4000-8000-000000000002",
        conversationId:
          typeof params.conversationId === "string"
            ? params.conversationId
            : "00000000-0000-4000-8000-000000000001",
      },
    };
  }
  return {};
}

const BAD_SERVER_NOW = "2026-01-01T00:00:00.000Z";
const BAD_TASK_ID = "00000000-0000-4000-8000-000000000201";
const BAD_TASK_CONVERSATION_ID = "00000000-0000-4000-8000-000000000203";

const taskCloseLifecycleBadResultHandlers = new Map<
  string,
  (request: RequestFrame) => unknown
>([
  [TaskRequest.name, badTaskCreateResult],
  [TaskAddParticipant.name, badTaskParticipant],
  [TaskConversationCreate.name, badTaskConversation],
  [TaskClose.name, badTaskCloseResult],
  [MessagesSend.name, badTaskMessageSendResult],
]);

function makeTaskCloseLifecycleBadResult(request: RequestFrame): unknown {
  return (
    taskCloseLifecycleBadResultHandlers.get(request.method)?.(request) ?? {}
  );
}

function badTaskCreateResult(request: RequestFrame): unknown {
  const params = request.params as { appId?: unknown };
  return {
    task: badTask({
      id: BAD_TASK_ID,
      appId: typeof params.appId === "string" ? params.appId : "bad-server-app",
      status: "waiting",
    }),
  };
}

function badTaskCloseResult(): unknown {
  return {
    task: badTask({
      id: BAD_TASK_ID,
      appId: "task-close-lifecycle-app",
      status: "closed",
      endedAt: BAD_SERVER_NOW,
    }),
  };
}

function badTaskMessageSendResult(request: RequestFrame): unknown {
  const params = request.params as { conversationId?: unknown };
  return {
    message: {
      id: "00000000-0000-4000-8000-000000000204",
      conversationId:
        typeof params.conversationId === "string"
          ? params.conversationId
          : BAD_TASK_CONVERSATION_ID,
    },
  };
}

function badTaskParticipant(request: RequestFrame): unknown {
  const params = request.params as { taskId?: unknown; agentId?: unknown };
  return {
    participant: {
      taskId: typeof params.taskId === "string" ? params.taskId : BAD_TASK_ID,
      agentId:
        typeof params.agentId === "string"
          ? params.agentId
          : badServerAgentId(2),
      admittedAt: BAD_SERVER_NOW,
    },
  };
}

function badTaskConversation(request: RequestFrame): unknown {
  const params = request.params as { type?: unknown; name?: unknown };
  return {
    conversation: {
      id: BAD_TASK_CONVERSATION_ID,
      type: params.type === "dm" ? "dm" : "group",
      ...(typeof params.name === "string" ? { name: params.name } : {}),
      createdBy: badServerAgentId(1),
      createdAt: BAD_SERVER_NOW,
      updatedAt: BAD_SERVER_NOW,
    },
  };
}

function badTask(opts: {
  readonly id: string;
  readonly appId: string;
  readonly status: "waiting" | "active" | "failed" | "closed";
  readonly endedAt?: string;
}) {
  return {
    id: opts.id,
    appId: opts.appId,
    initiatorAgentId: badServerAgentId(1),
    status: opts.status,
    startedAt: null,
    endedAt: opts.endedAt ?? null,
    createdAt: BAD_SERVER_NOW,
  };
}
