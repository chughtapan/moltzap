import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "vitest";
import { Effect, Ref, Scope } from "effect";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import type { RequestFrame, ResponseFrame } from "../../../schema/frames.js";
import { ErrorCodes } from "../../../schema/errors.js";
import { decodeFrame, encodeFrame } from "../../codec.js";
import type { ConformanceArtifact } from "../runner.js";
import type { ConformanceRunContext, RealServerHandle } from "../runner.js";
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

type BadServerBehavior =
  | "allow-unauthenticated"
  | "duplicate-response-id"
  | "drop-contacts-list"
  | "drop-sampled-response"
  | "reject-confident-model-call"
  | "reject-authorized"
  | "drift-idempotent-result";

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
      close: () => Promise.resolve(),
    };
    return {
      realServer,
      toxiproxy: null,
      opts: {
        tiers: ["A", "B", "C", "E"],
        realServer: () => Promise.resolve(realServer),
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
                  decoded.right.method === "conversations/list"
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
  if (behavior === "drop-contacts-list" && request.method === "contacts/list") {
    return null;
  }
  if (
    behavior === "drop-sampled-response" &&
    ordinal > 1 &&
    request.method !== "auth/connect"
  ) {
    return null;
  }
  if (
    (behavior === "reject-confident-model-call" &&
      request.method === "agents/list") ||
    (behavior === "reject-authorized" &&
      request.method === "conversations/list")
  ) {
    return {
      jsonrpc: "2.0",
      type: "response",
      id: request.id,
      error: {
        code: ErrorCodes.InternalError,
        message: "bad server rejects model-ok call",
      },
    };
  }
  return {
    jsonrpc: "2.0",
    type: "response",
    id: request.id,
    result: makeBadResult(request, behavior, ordinal),
  };
}

function makeBadResult(
  request: RequestFrame,
  behavior: BadServerBehavior,
  ordinal: number,
): unknown {
  switch (request.method) {
    case "auth/connect":
      return {};
    case "agents/list":
      return { agents: {} };
    case "conversations/list":
      return behavior === "drift-idempotent-result"
        ? { conversations: [{ id: `drift-${ordinal}`, name: "drift" }] }
        : { conversations: [] };
    default:
      return {};
  }
}
