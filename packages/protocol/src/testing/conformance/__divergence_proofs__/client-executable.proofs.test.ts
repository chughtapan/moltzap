import { describe, it } from "vitest";
import { Deferred, Effect, Ref, Scope } from "effect";
import type {
  NotificationFrame,
  RequestFrame,
  ResponseFrame,
} from "../../../transport/wire.js";
import {
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
} from "../../../task/methods.js";
import type { TestServer, TestServerConnection } from "../../test-server.js";
import { makeCaptureBuffer, recordFrame } from "../../captures.js";
import { encodeFrame } from "../../codec.js";
import { requestFrame } from "../../../transport/wire.js";
import { rpcMethods } from "../../../rpc-registry.js";
import { jsonRpcMethod } from "../../../transport/wire.js";
import type { ConformanceArtifact } from "../_shared/runner.js";
import {
  collectProperties,
  type PropertyFailure,
} from "../_shared/registry.js";
import {
  registerNotificationWellFormednessClient,
  registerMalformedFrameHandlingClient,
  registerModelEquivalenceClient,
  registerRequestIdUniquenessClient,
  registerFanOutCardinalityClient,
  registerPayloadOpacityClient,
  registerTaskBoundaryIsolationClient,
  registerArchiveLifecycleClient,
  registerSchemaExhaustiveFuzzClient,
} from "../client/index.js";
import {
  lookupTagForRawBytes,
  registerEmittedFrameTag,
} from "../client/runner.js";
import type {
  ClientConformanceRunContext,
  ClientHandshakeWindow,
  ObservedNotification,
  RealClientCloseEvent,
  RealClientNotificationSubscriber,
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
  | "rewrite-conversation-id"
  | "swap-archive-lifecycle"
  | "close-on-malformed"
  | "close-on-untagged-fuzz";

type RpcBehavior = "normal" | "non-response-type" | "spurious-id";

interface BadClientOptions {
  readonly eventBehavior?: EventBehavior;
  readonly rpcBehavior?: RpcBehavior;
}

describe("client-side conformance executable divergence proofs", () => {
  it("registerNotificationWellFormednessClient fails when surfaced notifications lose required fields", async () => {
    const failure = await runSingleClientProof(
      registerNotificationWellFormednessClient,
      { eventBehavior: "strip-required-field" },
    );
    expectInvariant(failure, "notification-well-formedness-client");
  }, 30_000);

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

  it("registerMalformedFrameHandlingClient fails when malformed frames poison liveness", async () => {
    const failure = await runSingleClientProof(
      registerMalformedFrameHandlingClient,
      { eventBehavior: "close-on-malformed" },
    );
    expectInvariant(failure, "malformed-frame-handling-client");
  }, 10_000);

  it("registerTaskBoundaryIsolationClient fails when task ids are cross-wired", async () => {
    const failure = await runSingleClientProof(
      registerTaskBoundaryIsolationClient,
      { eventBehavior: "rewrite-conversation-id" },
    );
    expectInvariant(failure, "task-boundary-isolation-client");
  });

  it("registerArchiveLifecycleClient fails when archive lifecycle order is wrong", async () => {
    const failure = await runSingleClientProof(registerArchiveLifecycleClient, {
      eventBehavior: "swap-archive-lifecycle",
    });
    expectInvariant(failure, "archive-lifecycle-client");
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
    const eventsRef = yield* Ref.make<ReadonlyArray<ObservedNotification>>([]);
    const outboundIdsRef = yield* Ref.make<ReadonlyArray<string>>([]);
    const closeRef = yield* Ref.make<RealClientCloseEvent | null>(null);
    const connectionRef = yield* Ref.make<TestServerConnection | null>(null);
    const pendingRef = yield* Ref.make<
      ReadonlyMap<
        string,
        Deferred.Deferred<ResponseFrame | NotificationFrame, RealClientRpcError>
      >
    >(new Map());
    // For spurious-id mode: buffer responses that arrive before any pending
    // exists, so the bad client can later cross-correlate them onto a real
    // pending call. Without this buffer the spurious response is silently
    // dropped and the divergence proof fails to demonstrate the bug.
    const bufferedResponseRef = yield* Ref.make<ResponseFrame | null>(null);
    const artifacts = yield* Ref.make<ReadonlyArray<ConformanceArtifact>>([]);
    const inbound = yield* makeCaptureBuffer({ capacity: 256 });

    const publishNotification = (
      frame: NotificationFrame,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const behavior = opts.eventBehavior ?? "normal";
        const close = yield* Ref.get(closeRef);
        if (close !== null && behavior === "close-on-malformed") return;
        // Post-Phase-12 (#222) the runner records the (raw → tag) map at
        // emit time rather than injecting `__emissionTag` into the
        // payload (which would fail per-method validation). Read the
        // tag back via the same registry the real adapter uses.
        const preEncoded = new TextEncoder().encode(JSON.stringify(frame));
        const tag = lookupTagForRawBytes(preEncoded);
        if (behavior === "close-on-untagged-fuzz" && tag === null) {
          yield* Ref.set(closeRef, {
            code: 1002,
            reason: "bad client closed during fuzz",
            observedAtMs: Date.now(),
          });
        }
        const surfaceFrame =
          behavior === "strip-required-field"
            ? stripNotificationName(frame)
            : behavior === "scramble-position-index"
              ? scrambleMessagePart(frame)
              : behavior === "rewrite-payload"
                ? rewriteMessagePatchedBy(frame, "rewritten")
                : behavior === "rewrite-conversation-id"
                  ? rewriteMessageConversationId(frame, "cross-wired-task")
                  : behavior === "swap-archive-lifecycle"
                    ? swapArchiveLifecycleNotification(frame)
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
        if (behavior === "spurious-id") {
          // Cross-correlation bug: route the FIRST response we see (whether
          // its id matches or not) onto whatever the next pending call is.
          // If no pending exists yet, buffer for later.
          const firstPendingId = pending.keys().next().value;
          if (typeof firstPendingId !== "string") {
            yield* Ref.set(bufferedResponseRef, response);
            return;
          }
          const deferred = pending.get(firstPendingId);
          if (deferred === undefined) return;
          yield* Deferred.succeed(deferred, response);
          return;
        }
        if (typeof response.id !== "string") return;
        const deferred = pending.get(response.id);
        if (deferred === undefined) return;
        const resolved =
          behavior === "non-response-type"
            ? ({
                jsonrpc: "2.0",
                method: jsonRpcMethod("proof/non-response"),
                params: response,
              } as NotificationFrame)
            : response;
        yield* Deferred.succeed(deferred, resolved);
      });

    const connection: TestServerConnection = {
      connectionId: "bad-client-proof-connection",
      remoteAddr: "in-memory",
      inbound,
      emitNotification: (notification) => publishNotification(notification),
      emitResponse: (response) => resolveResponse(response),
      emitMalformed: () =>
        opts.eventBehavior === "close-on-malformed"
          ? Ref.set(closeRef, {
              code: 1002,
              reason: "bad client closed on malformed frame",
              observedAtMs: Date.now(),
            })
          : Effect.void,
      close: (close) =>
        Ref.set(closeRef, {
          code: close.code,
          reason: close.reason,
          observedAtMs: Date.now(),
        }),
    };
    yield* Ref.set(connectionRef, connection);

    const notifications: RealClientNotificationSubscriber = {
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
          ResponseFrame | NotificationFrame,
          RealClientRpcError
        >();
        yield* Ref.update(
          pendingRef,
          (pending) => new Map([...pending, [id, deferred]]),
        );
        yield* Ref.update(outboundIdsRef, (ids) => [...ids, id]);
        // Spurious-id mode: if the bad client buffered an earlier response
        // before any pending existed, cross-correlate it onto this fresh
        // pending. This is the cross-correlation bug B4 catches.
        if ((opts.rpcBehavior ?? "normal") === "spurious-id") {
          const buffered = yield* Ref.get(bufferedResponseRef);
          if (buffered !== null) {
            yield* Ref.set(bufferedResponseRef, null);
            yield* Deferred.succeed(deferred, buffered);
          }
        }
        const conn = yield* Ref.get(connectionRef);
        if (conn === null) {
          return yield* Effect.die(new Error("connection not initialized"));
        }
        const definition = rpcMethods.find((def) => def.name === method);
        if (definition === undefined || !definition.validateParams(_params)) {
          return yield* Effect.die(new Error(`invalid proof RPC: ${method}`));
        }
        const request: RequestFrame = requestFrame(id, definition, _params);
        yield* recordFrame(
          conn.inbound,
          "inbound",
          encodeFrame(request),
          request,
        );
        return yield* Deferred.await(deferred);
      });

    const handle: RealClientHandle = {
      agentId: "00000000-0000-4000-8000-baadc11e7e57",
      ready: Effect.void,
      notifications,
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

    let badProofTagCounter = 0;
    const handshakeWindow: ClientHandshakeWindow = {
      freshEmissionTag: Effect.sync(() => {
        badProofTagCounter += 1;
        return `bad-proof-tag-${badProofTagCounter}`;
      }),
      emitTaggedNotification: ({ connection, base, emissionTag }) => {
        // Mirror `emitTaggedNotificationDefault`: register the (raw → tag)
        // mapping on the runner's shared registry so `lookupTagForRawBytes`
        // (used by both the real adapter and `publishNotification` below)
        // resolves the tag from the wire bytes instead of an injected
        // `__emissionTag` field that fails per-method validation.
        registerEmittedFrameTag(JSON.stringify(base), emissionTag);
        return connection.emitNotification(base).pipe(Effect.as(emissionTag));
      },
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

function stripNotificationName(frame: NotificationFrame): unknown {
  const withoutMethod: Partial<NotificationFrame> = { ...frame };
  delete withoutMethod.method;
  return withoutMethod;
}

/** Bug-injection: rewrite the message's `parts[0].text` so the C1
 * cardinality predicate observes a duplicate tag-position binding (the
 * test post-Phase-12 keys uniqueness on wire bytes; clobbering the part
 * text collapses two emissions onto the same wire form). */
function scrambleMessagePart(frame: NotificationFrame): NotificationFrame {
  const params = (frame.params ?? {}) as Record<string, unknown>;
  const message = (params.message ?? {}) as Record<string, unknown>;
  return {
    ...frame,
    params: {
      ...params,
      message: { ...message, parts: [{ type: "text", text: "scrambled" }] },
    },
  } as NotificationFrame;
}

/** Bug-injection: overwrite `message.patchedBy` so the C3 payload-
 * opacity predicate cannot find its marker token in the surfaced raw
 * frame. */
function rewriteMessagePatchedBy(
  frame: NotificationFrame,
  newPatchedBy: string,
): NotificationFrame {
  const params = (frame.params ?? {}) as Record<string, unknown>;
  const message = (params.message ?? {}) as Record<string, unknown>;
  return {
    ...frame,
    params: {
      ...params,
      message: { ...message, patchedBy: newPatchedBy },
    },
  } as NotificationFrame;
}

/** Bug-injection: cross-wire `params.conversationId` so the C4 task-
 * boundary predicate detects the rewritten id on the surfaced
 * observation. */
function rewriteMessageConversationId(
  frame: NotificationFrame,
  newId: string,
): NotificationFrame {
  const params = (frame.params ?? {}) as Record<string, unknown>;
  return {
    ...frame,
    params: { ...params, conversationId: newId },
  } as NotificationFrame;
}

function swapArchiveLifecycleNotification(
  frame: NotificationFrame,
): NotificationFrame {
  if (frame.method === ConversationArchivedNotificationDefinition.name) {
    return {
      ...frame,
      method: ConversationUnarchivedNotificationDefinition.name,
    } as NotificationFrame;
  }
  if (frame.method === ConversationUnarchivedNotificationDefinition.name) {
    return {
      ...frame,
      method: ConversationArchivedNotificationDefinition.name,
    } as NotificationFrame;
  }
  return frame;
}
