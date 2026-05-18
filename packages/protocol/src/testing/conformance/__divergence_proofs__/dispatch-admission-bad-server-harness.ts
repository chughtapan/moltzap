import { Effect, Ref, Scope } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import * as Socket from "@effect/platform/Socket";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import type {
  ConformanceArtifact,
  ConformanceRunContext,
  RealServerHandle,
} from "../_shared/runner.js";
import {
  collectProperties,
  type PropertyFailure,
} from "../_shared/registry.js";
import { runExpectingFailure } from "./executable-proof-helpers.js";
import type {
  BadDispatchRefs,
  BadServerBehavior,
} from "./dispatch-admission-bad-server-model.js";
import {
  badServerAgentId,
  makeBadDispatchRefs,
} from "./dispatch-admission-bad-server-model.js";
import {
  handleInboundFrame,
  onConnectionClose,
} from "./dispatch-admission-bad-server-handlers.js";

export function runSingleDispatchProof(
  register: (ctx: ConformanceRunContext) => void,
  opts: { readonly behavior: BadServerBehavior },
): Effect.Effect<PropertyFailure> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* makeBadDispatchServerContext(opts.behavior);
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
    if (exit._tag === "Failure") {
      return yield* Effect.die(
        new Error(`proof harness defect: ${exit.cause.toString()}`),
      );
    }
    return exit.value;
  }).pipe(Effect.withSpan("runSingleDispatchProof"));
}

function makeBadDispatchServerContext(
  behavior: BadServerBehavior,
): Effect.Effect<
  ConformanceRunContext,
  never,
  Scope.Scope | HttpServer.HttpServer
> {
  return Effect.gen(function* () {
    const httpHandle = yield* makeRegistrationHttpServer;
    const wsHandle = yield* makeBadDispatchWebSocketServer(behavior);
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

function makeBadDispatchWebSocketServer(
  behavior: BadServerBehavior,
): Effect.Effect<{ readonly wsUrl: string }, never, Scope.Scope> {
  return Effect.gen(function* () {
    const refs = yield* makeBadDispatchRefs();
    const server = yield* NodeSocketServer.makeWebSocket({
      port: 0,
      host: "127.0.0.1",
    }).pipe(Effect.orDie);
    yield* Effect.forkScoped(
      server
        .run((socket) => runBadDispatchConnection(socket, refs, behavior))
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

function runBadDispatchConnection(
  socket: Socket.Socket,
  refs: BadDispatchRefs,
  behavior: BadServerBehavior,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const connId = yield* Ref.updateAndGet(refs.connCounter, (n) => n + 1);
    const writer = yield* socket.writer;
    const writeEffect = (raw: string) => writer(raw).pipe(Effect.orDie);
    yield* Ref.update(refs.stateRef, (s) => {
      s.writers.set(connId, writeEffect);
      return s;
    });
    yield* socket
      .runRaw((data) =>
        handleInboundFrame({
          raw: socketDataToString(data),
          connId,
          stateRef: refs.stateRef,
          authorizeWaiters: refs.authorizeWaiters,
          collisionLeaseIdRef: refs.collisionLeaseIdRef,
          firstAckHeldRef: refs.firstAckHeldRef,
          mintCounterByRecipient: refs.mintCounterByRecipient,
          nextEmitIndexByRecipient: refs.nextEmitIndexByRecipient,
          behavior,
        }),
      )
      .pipe(
        Effect.ensuring(
          onConnectionClose({
            connId,
            stateRef: refs.stateRef,
            authorizeWaiters: refs.authorizeWaiters,
            behavior,
          }),
        ),
        Effect.ignore,
      );
  }).pipe(Effect.ignore);
}

function socketDataToString(data: string | Uint8Array): string {
  return typeof data === "string"
    ? data
    : new TextDecoder("utf-8").decode(data);
}
