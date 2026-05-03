import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "vitest";
import { Effect, Ref, Scope } from "effect";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import type { RequestFrame, ResponseFrame } from "../../../schema/frames.js";
import { ErrorCodes } from "../../../schema/errors.js";
import { responseFrame } from "../../../helpers.js";
import {
  AppsCloseSession,
  AppsCreate,
  AppsRegister,
} from "../../../schema/methods/apps.js";
import {
  ConversationsArchive,
  ConversationsCreate,
  ConversationsUnarchive,
  ConversationsUpdate,
} from "../../../schema/methods/conversations.js";
import { MessagesSend } from "../../../schema/methods/messages.js";
import { decodeFrame, encodeFrame } from "../../codec.js";
import type { ConformanceArtifact } from "../runner.js";
import type { ConformanceRunContext, RealServerHandle } from "../runner.js";
import {
  registerAppSessionCloseLifecycle,
  registerArchiveLifecycle,
  registerConversationLifecycle,
} from "../delivery.js";
import {
  registerConnectBroadcast,
  registerDisconnectBroadcast,
  registerMultiSubscriberFanOut,
  registerReconnectStorm,
  registerSameStateNoDoubleFire,
  registerSubscribeAfterConnect,
} from "../presence.js";
import { collectProperties, type PropertyFailure } from "../registry.js";
import {
  registerAuthorityPositive,
  registerAuthorityNegative,
  registerIdempotence,
  registerModelEquivalence,
  registerRequestIdUniqueness,
} from "../rpc-semantics.js";
import {
  registerRequestWellFormedness,
  registerRpcMapCoverage,
} from "../schema-conformance.js";
import {
  expectAssertionFailure,
  expectInvariant,
  runExpectingFailure,
} from "./executable-proof-helpers.js";

import { AgentsList, Connect } from "../../../schema/methods/auth.js";
import { ContactsList } from "../../../schema/methods/contacts.js";
import { ConversationsList } from "../../../schema/methods/conversations.js";
import {
  PresenceSubscribe,
  PresenceUpdate,
} from "../../../schema/methods/presence.js";

type BadServerBehavior =
  | "allow-unauthenticated"
  | "duplicate-response-id"
  | "drop-contacts-list"
  | "drop-sampled-response"
  | "reject-confident-model-call"
  | "reject-authorized"
  | "drift-idempotent-result"
  | "conversation-missing-created-event"
  | "app-close-missing-lifecycle-event"
  | "archive-missing-event"
  | "presence-silent"
  | "presence-stale-snapshot";

describe("server-side conformance executable divergence proofs", () => {
  it("registerAuthorityNegative fails when pre-handshake RPCs return success", async () => {
    const failure = await runSingleServerProof(registerAuthorityNegative, {
      behavior: "allow-unauthenticated",
    });
    expectInvariant(failure, "authority-negative");
  });

  it("registerModelEquivalence fails when a confident model-ok call errors", async () => {
    const failure = await runSingleServerProof(registerModelEquivalence, {
      behavior: "reject-confident-model-call",
    });
    expectAssertionFailure(failure, "model-equivalence");
  });

  it("registerAuthorityPositive fails when an authorized RPC is denied", async () => {
    const failure = await runSingleServerProof(registerAuthorityPositive, {
      behavior: "reject-authorized",
    });
    expectInvariant(failure, "authority-positive");
  });

  it("registerRequestIdUniqueness fails when responses duplicate an id", async () => {
    const failure = await runSingleServerProof(registerRequestIdUniqueness, {
      behavior: "duplicate-response-id",
    });
    expectAssertionFailure(failure, "request-id-uniqueness");
  });

  it("registerIdempotence fails when list results drift across replays", async () => {
    const failure = await runSingleServerProof(registerIdempotence, {
      behavior: "drift-idempotent-result",
    });
    expectInvariant(failure, "idempotence");
  });

  it("registerRequestWellFormedness fails when sampled calls receive no reply", async () => {
    const failure = await runSingleServerProof(registerRequestWellFormedness, {
      behavior: "drop-sampled-response",
    });
    expectAssertionFailure(failure, "request-well-formedness");
  }, 12_000);

  it("registerRpcMapCoverage fails when a sampled method never responds", async () => {
    const failure = await runSingleServerProof(registerRpcMapCoverage, {
      behavior: "drop-contacts-list",
    });
    expectInvariant(failure, "rpc-map-coverage");
  });

  it("registerArchiveLifecycle fails when archive does not broadcast lifecycle", async () => {
    const failure = await runSingleServerProof(registerArchiveLifecycle, {
      behavior: "archive-missing-event",
    });
    expectInvariant(failure, "archive-lifecycle");
  }, 10_000);

  it("registerConversationLifecycle fails when create does not broadcast lifecycle", async () => {
    const failure = await runSingleServerProof(registerConversationLifecycle, {
      behavior: "conversation-missing-created-event",
    });
    expectInvariant(failure, "conversation-lifecycle");
  }, 10_000);

  it("registerAppSessionCloseLifecycle fails when close does not broadcast lifecycle", async () => {
    const failure = await runSingleServerProof(
      registerAppSessionCloseLifecycle,
      {
        behavior: "app-close-missing-lifecycle-event",
      },
    );
    expectInvariant(failure, "app-session-close-lifecycle");
  }, 10_000);

  // Presence — all six fail under a server that answers RPCs but never
  // broadcasts presence/changed (the pre-arena#252 shape).
  it("registerConnectBroadcast fails when auth/connect does not broadcast presence/changed", async () => {
    const failure = await runSingleServerProof(registerConnectBroadcast, {
      behavior: "presence-silent",
    });
    expectInvariant(failure, "connect-broadcast");
  }, 10_000);

  it("registerDisconnectBroadcast fails when ws-close does not broadcast presence/changed", async () => {
    const failure = await runSingleServerProof(registerDisconnectBroadcast, {
      behavior: "presence-silent",
    });
    expectInvariant(failure, "disconnect-broadcast");
  }, 10_000);

  it("registerReconnectStorm fails when no presence/changed events fire on connect/disconnect", async () => {
    const failure = await runSingleServerProof(registerReconnectStorm, {
      behavior: "presence-silent",
    });
    expectInvariant(failure, "reconnect-storm");
  }, 10_000);

  it("registerSameStateNoDoubleFire fails when no presence/changed event fires on initial connect", async () => {
    const failure = await runSingleServerProof(registerSameStateNoDoubleFire, {
      behavior: "presence-silent",
    });
    expectInvariant(failure, "same-state-no-double-fire");
  }, 10_000);

  it("registerMultiSubscriberFanOut fails when subscribers receive no presence/changed event", async () => {
    const failure = await runSingleServerProof(registerMultiSubscriberFanOut, {
      behavior: "presence-silent",
    });
    expectInvariant(failure, "multi-subscriber-fan-out");
  }, 10_000);

  it("registerSubscribeAfterConnect fails when subscribe snapshot reports stale offline for a connected agent", async () => {
    const failure = await runSingleServerProof(registerSubscribeAfterConnect, {
      behavior: "presence-stale-snapshot",
    });
    expectInvariant(failure, "subscribe-after-connect");
  }, 10_000);
});

async function runSingleServerProof(
  register: (ctx: ConformanceRunContext) => void,
  opts: { readonly behavior: BadServerBehavior },
): Promise<PropertyFailure> {
  const exit = await Effect.runPromiseExit(
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
    ),
  );
  if (exit._tag === "Failure") {
    throw new Error(`proof harness defect: ${exit.cause.toString()}`);
  }
  return exit.value;
}

function makeBadServerContext(
  behavior: BadServerBehavior,
): Effect.Effect<ConformanceRunContext, never, Scope.Scope> {
  return Effect.gen(function* () {
    const httpHandle = yield* makeRegistrationHttpServer;
    const wsHandle = yield* makeBadWebSocketServer(behavior);
    const artifacts = yield* Ref.make<ReadonlyArray<ConformanceArtifact>>([]);
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
      artifacts,
    } satisfies ConformanceRunContext;
  });
}

const makeRegistrationHttpServer: Effect.Effect<
  { readonly baseUrl: string },
  never,
  Scope.Scope
> = Effect.gen(function* () {
  let counter = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/auth/register") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    req.resume();
    req.on("end", () => {
      counter += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          agentId: `bad-server-agent-${counter}`,
          apiKey: `bad-server-key-${counter}`,
          claimUrl: `http://127.0.0.1/claim/${counter}`,
          claimToken: `claim-${counter}`,
        }),
      );
    });
  });

  const listening = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<http.Server>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve(server);
          });
        }),
      catch: (cause) => cause,
    }).pipe(Effect.orDie),
    (active) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            active.close(() => resolve());
          }),
      ).pipe(Effect.orDie),
  );
  const address = listening.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
});

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
            yield* socket.runRaw((data) => {
              const raw =
                typeof data === "string"
                  ? data
                  : new TextDecoder("utf-8").decode(data);
              return Effect.gen(function* () {
                const decoded = yield* Effect.either(
                  decodeFrame(raw, "inbound"),
                );
                if (
                  decoded._tag === "Left" ||
                  decoded.right.type !== "request"
                ) {
                  return;
                }
                const ordinal = yield* Ref.updateAndGet(
                  requestCounter,
                  (n) => n + 1,
                );
                const response = makeBadResponse(
                  decoded.right,
                  behavior,
                  ordinal,
                );
                if (response === null) return;
                yield* writer(encodeFrame(response)).pipe(Effect.orDie);
                if (
                  behavior === "duplicate-response-id" &&
                  decoded.right.method === ConversationsList.name
                ) {
                  yield* writer(encodeFrame(response)).pipe(Effect.orDie);
                }
              });
            });
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

function makeBadResponse(
  request: RequestFrame,
  behavior: BadServerBehavior,
  ordinal: number,
): ResponseFrame | null {
  if (
    behavior === "drop-contacts-list" &&
    request.method === ContactsList.name
  ) {
    return null;
  }
  if (
    behavior === "drop-sampled-response" &&
    ordinal > 1 &&
    request.method !== Connect.name
  ) {
    return null;
  }
  if (
    (behavior === "reject-confident-model-call" &&
      request.method === AgentsList.name) ||
    (behavior === "reject-authorized" &&
      request.method === ConversationsList.name)
  ) {
    return responseFrame("c2s", request.id, {
      error: {
        code: ErrorCodes.InternalError,
        message: "bad server rejects model-ok call",
      },
    });
  }
  return responseFrame("c2s", request.id, {
    result: makeBadResult(request, behavior, ordinal),
  });
}

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
  if (behavior === "app-close-missing-lifecycle-event") {
    return makeAppSessionCloseLifecycleBadResult(request);
  }
  if (
    behavior === "presence-silent" ||
    behavior === "presence-stale-snapshot"
  ) {
    if (request.method === PresenceSubscribe.name) {
      // Always reports offline — fails P6's online-snapshot expectation
      // and seeds the snapshot empty for the silent-broadcast cases.
      const params = request.params as { agentIds?: ReadonlyArray<unknown> };
      const ids = Array.isArray(params.agentIds) ? params.agentIds : [];
      return {
        statuses: ids
          .filter((id): id is string => typeof id === "string")
          .map((agentId) => ({ agentId, status: "offline" as const })),
      };
    }
    if (request.method === PresenceUpdate.name) {
      return {};
    }
  }
  switch (request.method) {
    case Connect.name:
      return {};
    case AgentsList.name:
      return { agents: {} };
    case ConversationsList.name:
      return behavior === "drift-idempotent-result"
        ? { conversations: [{ id: `drift-${ordinal}`, name: "drift" }] }
        : { conversations: [] };
    default:
      return {};
  }
}

function makeAppSessionCloseLifecycleBadResult(request: RequestFrame): unknown {
  if (request.method === AppsRegister.name) {
    const params = request.params as { manifest?: { appId?: unknown } };
    return {
      appId:
        typeof params.manifest?.appId === "string"
          ? params.manifest.appId
          : "bad-close-app",
    };
  }
  if (request.method === AppsCreate.name) {
    const params = request.params as { appId?: unknown };
    return {
      session: {
        id: "00000000-0000-4000-8000-000000000201",
        appId:
          typeof params.appId === "string" ? params.appId : "bad-close-app",
        initiatorAgentId: "bad-server-agent-2",
        status: "active",
        conversations: {
          main: "00000000-0000-4000-8000-000000000202",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    };
  }
  if (request.method === AppsCloseSession.name) {
    return { closed: true };
  }
  if (request.method === MessagesSend.name) {
    return {
      message: {
        id: "00000000-0000-4000-8000-000000000203",
        conversationId: "00000000-0000-4000-8000-000000000202",
      },
    };
  }
  return {};
}

function makeConversationLifecycleBadResult(request: RequestFrame): unknown {
  if (request.method === ConversationsCreate.name) {
    return {
      conversation: {
        id: "00000000-0000-4000-8000-000000000101",
        type: "group",
        name: "bad lifecycle",
        archived: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
  }
  if (request.method === ConversationsUpdate.name) {
    return {};
  }
  if (
    request.method === ConversationsArchive.name ||
    request.method === ConversationsUnarchive.name
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
  if (request.method === ConversationsCreate.name) {
    return {
      conversation: {
        id: "00000000-0000-4000-8000-000000000001",
      },
    };
  }
  if (
    request.method === ConversationsArchive.name ||
    request.method === ConversationsUnarchive.name
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
