import { describe, it } from "vitest";
import { Deferred, Effect, Ref, Scope } from "effect";
import type {
  EventFrame,
  RequestFrame,
  ResponseFrame,
} from "../../../schema/frames.js";
import type { TestServer, TestServerConnection } from "../../test-server.js";
import { makeCaptureBuffer, recordFrame } from "../../captures.js";
import { encodeFrame } from "../../codec.js";
import type { ConformanceArtifact } from "../runner.js";
import { collectProperties, type PropertyFailure } from "../registry.js";
import {
  registerEventWellFormednessClient,
  registerModelEquivalenceClient,
  registerRequestIdUniquenessClient,
  registerFanOutCardinalityClient,
  registerPayloadOpacityClient,
  registerSchemaExhaustiveFuzzClient,
} from "../client/index.js";
import type {
  ClientConformanceRunContext,
  ClientHandshakeWindow,
  ObservedEvent,
  RealClientCloseEvent,
  RealClientEventSubscriber,
  RealClientHandle,
  RealClientRpcCaller,
  RealClientRpcError,
  RealClientSubscription,
} from "../client/index.js";
import {
  expectInvariant,
  runExpectingFailure,
} from "./executable-proof-helpers.js";

type EventBehavior =
  | "normal"
  | "scramble-position-index"
  | "strip-required-field"
  | "rewrite-payload"
  | "close-on-untagged-fuzz";

type RpcBehavior = "normal" | "non-response-type" | "spurious-id";

interface BadClientOptions {
  readonly eventBehavior?: EventBehavior;
  readonly rpcBehavior?: RpcBehavior;
}

describe("client-side conformance executable divergence proofs", () => {
  it("registerEventWellFormednessClient fails when surfaced events lose required fields", async () => {
    const failure = await runSingleClientProof(
      registerEventWellFormednessClient,
      { eventBehavior: "strip-required-field" },
    );
    expectInvariant(failure, "event-well-formedness-client");
  });

  it("registerFanOutCardinalityClient fails when a real client scrambles fan-out order", async () => {
    const failure = await runSingleClientProof(
      registerFanOutCardinalityClient,
      {
        eventBehavior: "scramble-position-index",
      },
    );
    expectInvariant(failure, "fan-out-cardinality-client");
  });

  it("registerPayloadOpacityClient fails when a real client rewrites payload bytes", async () => {
    const failure = await runSingleClientProof(registerPayloadOpacityClient, {
      eventBehavior: "rewrite-payload",
    });
    expectInvariant(failure, "payload-opacity-client");
  });

  it("registerSchemaExhaustiveFuzzClient fails when post-fuzz liveness is poisoned", async () => {
    const failure = await runSingleClientProof(
      registerSchemaExhaustiveFuzzClient,
      { eventBehavior: "close-on-untagged-fuzz" },
    );
    expectInvariant(failure, "schema-exhaustive-fuzz-client");
  });

  it("registerModelEquivalenceClient fails when RPC returns a non-response frame", async () => {
    const failure = await runSingleClientProof(registerModelEquivalenceClient, {
      rpcBehavior: "non-response-type",
    });
    expectInvariant(failure, "model-equivalence-client");
  });

  it("registerRequestIdUniquenessClient fails when RPC resolves via a spurious id", async () => {
    const failure = await runSingleClientProof(
      registerRequestIdUniquenessClient,
      { rpcBehavior: "spurious-id" },
    );
    expectInvariant(failure, "request-id-uniqueness-client");
  });
});

async function runSingleClientProof(
  register: (ctx: ClientConformanceRunContext) => void,
  opts: BadClientOptions,
): Promise<PropertyFailure> {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* makeBadClientContext(opts);
        register(ctx);
        const properties = collectProperties(ctx);
        if (properties.length !== 1) {
          return yield* Effect.die(
            new Error(`expected one property, got ${properties.length}`),
          );
        }
        const property = properties[0]!;
        return yield* runExpectingFailure(property);
      }),
    ),
  );
  if (exit._tag === "Failure") {
    throw new Error(`proof harness defect: ${exit.cause.toString()}`);
  }
  return exit.value;
}

function makeBadClientContext(
  opts: BadClientOptions,
): Effect.Effect<ClientConformanceRunContext, never, Scope.Scope> {
  return Effect.gen(function* () {
    const eventsRef = yield* Ref.make<ReadonlyArray<ObservedEvent>>([]);
    const outboundIdsRef = yield* Ref.make<ReadonlyArray<string>>([]);
    const closeRef = yield* Ref.make<RealClientCloseEvent | null>(null);
    const connectionRef = yield* Ref.make<TestServerConnection | null>(null);
    const pendingRef = yield* Ref.make<
      ReadonlyMap<string, Deferred.Deferred<ResponseFrame, RealClientRpcError>>
    >(new Map());
    const artifacts = yield* Ref.make<ReadonlyArray<ConformanceArtifact>>([]);
    const inbound = yield* makeCaptureBuffer({ capacity: 256 });

    const publishEvent = (frame: EventFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        const behavior = opts.eventBehavior ?? "normal";
        const data = frame.data as { __emissionTag?: string } | undefined;
        const tag =
          typeof data?.__emissionTag === "string" ? data.__emissionTag : null;
        if (behavior === "close-on-untagged-fuzz" && tag === null) {
          yield* Ref.set(closeRef, {
            code: 1002,
            reason: "bad client closed during fuzz",
            observedAtMs: Date.now(),
          });
        }
        const surfaceFrame =
          behavior === "strip-required-field"
            ? stripEventName(frame)
            : behavior === "scramble-position-index"
              ? rewriteEventData(frame, { positionIndex: 999 })
              : behavior === "rewrite-payload"
                ? rewriteEventData(frame, { opaqueToken: "rewritten" })
                : frame;
        const encoded = new TextEncoder().encode(JSON.stringify(surfaceFrame));
        yield* Ref.update(eventsRef, (events) => [
          ...events,
          {
            emissionTag: tag,
            decoded: surfaceFrame,
            rawBytes: encoded,
            observedAtMs: Date.now(),
          },
        ]);
      });

    const resolveResponse = (response: ResponseFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        const behavior = opts.rpcBehavior ?? "normal";
        const pending = yield* Ref.get(pendingRef);
        const targetId =
          behavior === "spurious-id"
            ? pending.keys().next().value
            : response.id;
        if (typeof targetId !== "string") return;
        const deferred = pending.get(targetId);
        if (deferred === undefined) return;
        const resolved =
          behavior === "non-response-type"
            ? ({ ...response, type: "event" } as ResponseFrame)
            : behavior === "spurious-id"
              ? { ...response, id: "spurious-id-that-was-never-requested" }
              : response;
        yield* Deferred.succeed(deferred, resolved);
      });

    const connection: TestServerConnection = {
      connectionId: "bad-client-proof-connection",
      remoteAddr: "in-memory",
      inbound,
      emitEvent: (event) => publishEvent(event),
      emitResponse: (response) => resolveResponse(response),
      emitMalformed: () => Effect.void,
      close: (close) =>
        Ref.set(closeRef, {
          code: close.code,
          reason: close.reason,
          observedAtMs: Date.now(),
        }),
    };
    yield* Ref.set(connectionRef, connection);

    const events: RealClientEventSubscriber = {
      subscribe: () =>
        Effect.succeed({
          id: "bad-client-proof-subscription",
          unsubscribe: Effect.void,
        } satisfies RealClientSubscription),
      snapshot: Ref.get(eventsRef),
    };

    let requestCounter = 0;
    const call: RealClientRpcCaller["call"] = (method, _params) =>
      Effect.gen(function* () {
        requestCounter += 1;
        const id = `rpc-${requestCounter}`;
        const deferred = yield* Deferred.make<
          ResponseFrame,
          RealClientRpcError
        >();
        yield* Ref.update(
          pendingRef,
          (pending) => new Map([...pending, [id, deferred]]),
        );
        yield* Ref.update(outboundIdsRef, (ids) => [...ids, id]);
        const conn = yield* Ref.get(connectionRef);
        if (conn === null) {
          return yield* Effect.die(new Error("connection not initialized"));
        }
        const request: RequestFrame = {
          jsonrpc: "2.0",
          type: "request",
          id,
          method,
          params: _params,
        };
        yield* recordFrame(
          conn.inbound,
          "inbound",
          encodeFrame(request),
          request,
        );
        return yield* Deferred.await(deferred);
      });

    const handle: RealClientHandle = {
      agentId: "bad-client-proof-agent",
      ready: Effect.void,
      events,
      call: { call, outboundIdFeed: Ref.get(outboundIdsRef) },
      closeSignal: Effect.gen(function* () {
        while (true) {
          const close = yield* Ref.get(closeRef);
          if (close !== null) return close;
          yield* Effect.sleep("10 millis");
        }
      }),
      close: Effect.void,
    };

    const testServer: TestServer = {
      wsUrl: "ws://bad-client-proof.invalid",
      accept: Effect.succeed(connection),
      connections: Effect.succeed([connection]),
      allInbound: inbound,
      snapshot: inbound.snapshot,
    };

    const handshakeWindow: ClientHandshakeWindow = {
      freshEmissionTag: Effect.succeed("unused"),
      emitTaggedEvent: ({ connection, base, emissionTag }) =>
        connection
          .emitEvent(taggedEvent(base, emissionTag))
          .pipe(Effect.as(emissionTag)),
      emitTaggedResponse: ({ connection, base }) =>
        connection.emitResponse(base).pipe(Effect.as(base.id)),
      awaitHandshakeComplete: Effect.void,
    };

    return {
      testServer,
      realClientFactory: () => Effect.succeed(handle),
      handshakeWindow,
      toxiproxy: null,
      opts: {
        tiers: ["A", "B", "C", "E"],
        realClient: () => Effect.succeed(handle),
      },
      seed: 42,
      artifacts,
    } satisfies ClientConformanceRunContext;
  });
}

function taggedEvent(base: EventFrame, emissionTag: string): EventFrame {
  const data = (base.data ?? {}) as Record<string, unknown>;
  return {
    ...base,
    data: { ...data, __emissionTag: emissionTag },
  };
}

function rewriteEventData(
  frame: EventFrame,
  patch: Record<string, unknown>,
): EventFrame {
  const data = (frame.data ?? {}) as Record<string, unknown>;
  return {
    ...frame,
    data: { ...data, ...patch },
  };
}

function stripEventName(frame: EventFrame): EventFrame {
  const withoutEvent: Partial<EventFrame> = { ...frame };
  delete withoutEvent.event;
  return withoutEvent as EventFrame;
}
