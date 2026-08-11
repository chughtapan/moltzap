#!/usr/bin/env node
/** @file One-container entry point for an autonomous evaluation peer. */

import { FileSystem } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { messageReceivedNotificationDefinition } from "@moltzap/protocol/message";
import { MoltZapAgentClient } from "@moltzap/protocol/socket";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- This container-private one-route readiness bridge needs a raw bound port, while the controller consumes it through Effect HttpClient.
import { createServer, type Server } from "node:http";
import { Effect, Schema } from "effect";
import {
  EVALUATION_PEER_BRIDGE_PORT,
  EVALUATION_PEER_READY_MARKER,
  EvaluationPeerBootstrap,
  EvaluationPeerBridgeCompleted,
  EvaluationPeerBridgeFailed,
  EvaluationPeerBridgeResult,
  runEvaluationPeerApplication,
} from "./peer.js";

const decodeBootstrap = Schema.decodeUnknown(
  Schema.parseJson(EvaluationPeerBootstrap),
);
const encodeBridgeResult = Schema.encode(
  Schema.parseJson(EvaluationPeerBridgeResult),
);

/** The peer entrypoint could not establish its run-scoped process boundary. */
class EvaluationPeerApplicationStartupFailed extends Schema.TaggedError<EvaluationPeerApplicationStartupFailed>()(
  "EvaluationPeerApplicationStartupFailed",
  { detail: Schema.NonEmptyString },
) {}

interface BridgeState {
  readonly read: () => string | undefined;
  readonly publish: (result: string) => Effect.Effect<void>;
}

function bridgeState(): BridgeState {
  let current: string | undefined;
  return Object.freeze({
    read: () => current,
    publish: (result: string) =>
      Effect.sync(() => {
        current = result;
      }),
  });
}

function serveResult(state: BridgeState): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/result") {
      response.writeHead(404).end();
      return;
    }
    const result = state.read();
    if (result === undefined) {
      response.writeHead(204).end();
      return;
    }
    response
      .writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(result),
      })
      .end(result);
  });
}

function startupFailure(cause: unknown) {
  const detail = String(cause).trim();
  return EvaluationPeerApplicationStartupFailed.make({
    detail: detail.length > 0 ? detail : "peer application startup failed",
  });
}

function listen(
  state: BridgeState,
): Effect.Effect<Server, EvaluationPeerApplicationStartupFailed> {
  return Effect.async<Server, EvaluationPeerApplicationStartupFailed>(
    (resume) => {
      const server = serveResult(state);
      const failed = (cause: Error) => {
        resume(Effect.fail(startupFailure(cause)));
      };
      server.once("error", failed);
      server.listen(EVALUATION_PEER_BRIDGE_PORT, "0.0.0.0", () => {
        server.off("error", failed);
        resume(Effect.succeed(server));
      });
      return Effect.sync(() => {
        server.close();
      });
    },
  );
}

function close(server: Server): Effect.Effect<void> {
  return Effect.async<undefined>((resume) => {
    server.close(() => {
      resume(Effect.succeed(undefined));
    });
  }).pipe(Effect.asVoid);
}

function bridgeServer(state: BridgeState) {
  return Effect.acquireRelease(listen(state), close);
}

function bootstrapPath(
  args: readonly string[],
): Effect.Effect<string, EvaluationPeerApplicationStartupFailed> {
  const [path] = args;
  return args.length === 1 && path !== undefined && path.startsWith("/")
    ? Effect.succeed(path)
    : Effect.fail(
        EvaluationPeerApplicationStartupFailed.make({
          detail:
            "evaluation peer expects one absolute bootstrap configuration path",
        }),
      );
}

function readBootstrap(path: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.flatMap((source) =>
      decodeBootstrap(source, { onExcessProperty: "error" }),
    ),
  );
}

function announceReady(): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stdout.write(`${EVALUATION_PEER_READY_MARKER}\n`);
  });
}

function publishApplicationResult(
  state: BridgeState,
  result: EvaluationPeerBridgeCompleted | EvaluationPeerBridgeFailed,
) {
  return encodeBridgeResult(result).pipe(
    Effect.flatMap((encoded) => state.publish(encoded)),
  );
}

function runApplication(args: readonly string[]) {
  return Effect.gen(function* () {
    const path = yield* bootstrapPath(args);
    const configuration = yield* readBootstrap(path);
    const state = bridgeState();
    yield* bridgeServer(state);
    const client = new MoltZapAgentClient({
      serverUrl: configuration.serverUrl,
      agentKey: configuration.agentKey,
    });
    const messages = yield* client.subscribeScoped(
      messageReceivedNotificationDefinition,
    );
    yield* Effect.addFinalizer(() => client.close());
    yield* client.connect();
    yield* announceReady();
    yield* runEvaluationPeerApplication(
      {
        agent: Object.freeze({
          name: configuration.agentName,
          id: configuration.agentId,
        }),
        messages,
        client,
      },
      configuration.plan,
    ).pipe(
      Effect.matchEffect({
        onFailure: (failure) =>
          publishApplicationResult(
            state,
            EvaluationPeerBridgeFailed.make({ failure }),
          ),
        onSuccess: (exchange) =>
          publishApplicationResult(
            state,
            EvaluationPeerBridgeCompleted.make({ exchange }),
          ),
      }),
    );
    return yield* Effect.never;
  }).pipe(Effect.scoped, Effect.provide(NodeContext.layer));
}

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The executable boundary captures argv once before entering Effect.
runApplication(process.argv.slice(2)).pipe(NodeRuntime.runMain);
