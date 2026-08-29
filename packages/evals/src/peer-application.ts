#!/usr/bin/env node
/** @file Container entry point for one public-endpoint evaluation peer. */

import { NodeRuntime } from "@effect/platform-node";
import {
  acquireHarnessEndpoint,
  AgentAddress,
  type HarnessEndpoint,
} from "@moltzap/client";
import { Config, Deferred, Effect, Schema, type Scope } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- This private two-route readiness bridge owns a raw bound port while the controller uses the Effect HTTP client.
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  EVALUATION_PEER_AGENT_NAME_ENVIRONMENT,
  EVALUATION_PEER_BRIDGE_PORT,
  EVALUATION_PEER_PLAN_ENVIRONMENT,
  EVALUATION_PEER_READY_MARKER,
  EvaluationPeerBridgeCompleted,
  EvaluationPeerBridgeFailed,
  EvaluationPeerBridgeResult,
  EvaluationPeerFailed,
  EvaluationPeerPlan,
  runEvaluationPeerApplication,
} from "./peer.js";

/** The peer process could not establish its configuration or bridge. */
class EvaluationPeerApplicationStartupFailed extends Schema.TaggedError<EvaluationPeerApplicationStartupFailed>()(
  "EvaluationPeerApplicationStartupFailed",
  { detail: Schema.NonEmptyString },
) {}

interface ApplicationConfiguration {
  readonly endpointAddress: typeof AgentAddress.Type;
  readonly endpoint: URL;
  readonly plan: EvaluationPeerPlan;
}

interface BridgeState {
  readonly begin: () => boolean;
  readonly publish: (value: string) => void;
  readonly read: () => string | undefined;
  readonly triggered: Deferred.Deferred<undefined>;
}

function startupFailure(
  cause: unknown,
): EvaluationPeerApplicationStartupFailed {
  const rendered = cause instanceof Error ? cause.message : String(cause);
  return EvaluationPeerApplicationStartupFailed.make({
    detail:
      rendered.trim().length > 0
        ? rendered.trim()
        : "evaluation peer application startup failed",
  });
}

function peerFailure(
  operation: EvaluationPeerFailed["operation"],
  cause: unknown,
): EvaluationPeerFailed {
  const rendered = cause instanceof Error ? cause.message : String(cause);
  return EvaluationPeerFailed.make({
    operation,
    detail:
      rendered.trim().length > 0
        ? rendered.trim()
        : "evaluation peer operation failed",
  });
}

function readConfiguration(): Effect.Effect<
  ApplicationConfiguration,
  EvaluationPeerApplicationStartupFailed
> {
  return Effect.gen(function* () {
    const raw = yield* Config.all({
      agentName: Config.string(EVALUATION_PEER_AGENT_NAME_ENVIRONMENT),
      endpoint: Config.string("MOLTZAP_MCP_URL"),
      plan: Config.string(EVALUATION_PEER_PLAN_ENVIRONMENT),
    }).pipe(Effect.mapError(startupFailure));
    const [endpointAddress, plan, endpoint] = yield* Effect.all([
      Schema.decodeUnknown(AgentAddress)(`agent:${raw.agentName}`),
      Schema.decodeUnknown(Schema.parseJson(EvaluationPeerPlan))(raw.plan, {
        onExcessProperty: "error",
      }),
      Effect.try({
        try: () => new URL(raw.endpoint),
        catch: startupFailure,
      }),
    ] as const).pipe(Effect.mapError(startupFailure));
    return Object.freeze({ endpointAddress, endpoint, plan });
  });
}

function makeBridgeState(): Effect.Effect<BridgeState> {
  return Deferred.make<undefined>().pipe(
    Effect.map((triggered) => {
      let started = false;
      let result: string | undefined;
      return Object.freeze({
        begin: () => {
          if (started) {
            return false;
          }
          started = true;
          Effect.runFork(Deferred.succeed(triggered, undefined));
          return true;
        },
        publish: (value: string) => {
          result = value;
        },
        read: () => result,
        triggered,
      });
    }),
  );
}

function writeJson(response: ServerResponse, body: string) {
  response
    .writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    })
    .end(body);
}

function serveBridge(state: BridgeState): Server {
  return createServer((request, response) => {
    if (request.method === "POST" && request.url === "/run") {
      state.begin();
      response.writeHead(202).end();
      return;
    }
    if (request.method === "GET" && request.url === "/result") {
      const result = state.read();
      if (result === undefined) {
        response.writeHead(204).end();
      } else {
        writeJson(response, result);
      }
      return;
    }
    response.writeHead(404).end();
  });
}

function bridgeServer(state: BridgeState) {
  return Effect.acquireRelease(listen(state), close);
}

function listen(
  state: BridgeState,
): Effect.Effect<Server, EvaluationPeerApplicationStartupFailed> {
  return Effect.async<Server, EvaluationPeerApplicationStartupFailed>(
    (resume) => {
      const server = serveBridge(state);
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
  });
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
  return encodeResult(result).pipe(
    Effect.tap((encoded) =>
      Effect.sync(() => {
        state.publish(encoded);
      }),
    ),
    Effect.asVoid,
  );
}

function encodeResult(
  result: EvaluationPeerBridgeCompleted | EvaluationPeerBridgeFailed,
): Effect.Effect<string, EvaluationPeerApplicationStartupFailed> {
  return Effect.try({
    try: () =>
      Schema.encodeSync(Schema.parseJson(EvaluationPeerBridgeResult))(result),
    catch: startupFailure,
  });
}

function acquireEndpoint(
  endpoint: URL,
): Effect.Effect<HarnessEndpoint, EvaluationPeerFailed, Scope.Scope> {
  return acquireHarnessEndpoint(endpoint).pipe(
    Effect.mapError((cause) => peerFailure("connect", cause)),
  );
}

function runApplication() {
  return Effect.gen(function* () {
    const configuration = yield* readConfiguration();
    const state = yield* makeBridgeState();
    yield* bridgeServer(state);
    if (configuration.plan._tag === "moltzap.eval-peer-idle/v1") {
      yield* announceReady();
      return yield* Effect.never;
    }
    const endpoint = yield* acquireEndpoint(configuration.endpoint);
    yield* announceReady();
    yield* state.triggered;
    yield* runEvaluationPeerApplication(
      { endpointAddress: configuration.endpointAddress, endpoint },
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
  }).pipe(Effect.scoped);
}

runApplication().pipe(NodeRuntime.runMain);
