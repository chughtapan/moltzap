import { Effect, Ref } from "effect";
import type { ResponseFrame } from "../../../transport/wire.js";
import { responseFrame } from "../../../transport/wire.js";
import { encodeFrame } from "../_shared/frame-mutator.js";
import type {
  LeaseRecord,
  ModeratorVerdict,
  ServerState,
} from "./dispatch-admission-bad-server-model.js";
import {
  encodeRawWireFrame,
  freshUuidV4,
} from "./dispatch-admission-bad-server-model.js";

export function makeLeaseRecordWire(
  lease: LeaseRecord,
  state: ServerState,
  reportedLeaseId: string,
): unknown {
  const verdictWire = (() => {
    if (lease.verdict === null) return null;
    switch (lease.verdict._tag) {
      case "grant":
        return lease.verdict.leaseTimeoutMs !== undefined
          ? { decision: "grant", leaseTimeoutMs: lease.verdict.leaseTimeoutMs }
          : { decision: "grant" };
      case "deny":
        return lease.verdict.reason !== undefined
          ? { decision: "deny", reason: lease.verdict.reason }
          : { decision: "deny" };
      case "hold":
        return lease.verdict.reason !== undefined
          ? { decision: "hold", reason: lease.verdict.reason }
          : { decision: "hold" };
    }
  })();
  return {
    dispatchId: lease.dispatchId,
    leaseId: reportedLeaseId,
    conversationId: lease.conversationId,
    taskId: state.fixedTaskId,
    appId: "bad-server-app",
    recipientAgentId: lease.recipientAgentId,
    moderatorConnectionId: String(state.moderatorConnId ?? ""),
    tmEndpointAddress: "ws://bad-server-tm",
    state: lease.state,
    verdict: verdictWire,
    mintedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: lease.verdict !== null ? "2026-01-01T00:00:00.001Z" : null,
    consumedAt:
      lease.consumedMessageId !== null ? "2026-01-01T00:00:00.002Z" : null,
    consumedMessageId: lease.consumedMessageId,
    expiredAt: null,
    leaseTimeoutMs: lease.leaseTimeoutMs,
  };
}

export function emitReleaseFrame(args: {
  readonly stateRef: Ref.Ref<ServerState>;
  readonly recipientConnId: number;
  readonly dispatchId: string;
  readonly leaseId: string;
  readonly verdict: ModeratorVerdict;
  readonly leaseTimeoutMs: number | null;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(args.stateRef);
    const writer = state.writers.get(args.recipientConnId);
    if (writer === undefined) return;
    const params: Record<string, unknown> = {
      dispatchId: args.dispatchId,
      leaseId: args.leaseId,
      verdict: releaseVerdictWire(args),
    };
    if (args.verdict._tag === "grant" && args.leaseTimeoutMs !== null) {
      params.leaseTimeoutMs = args.leaseTimeoutMs;
    }
    yield* writer(
      encodeRawWireFrame({
        jsonrpc: "2.0",
        method: "dispatch/release",
        params,
      }),
    ).pipe(Effect.orDie);
  }).pipe(Effect.withSpan("emitReleaseFrame"));
}

function releaseVerdictWire(args: {
  readonly verdict: ModeratorVerdict;
  readonly leaseTimeoutMs: number | null;
}): unknown {
  switch (args.verdict._tag) {
    case "grant":
      return args.leaseTimeoutMs !== null
        ? { decision: "grant", leaseTimeoutMs: args.leaseTimeoutMs }
        : { decision: "grant" };
    case "deny":
      return args.verdict.reason !== undefined
        ? { decision: "deny", reason: args.verdict.reason }
        : { decision: "deny" };
    case "hold":
      return args.verdict.reason !== undefined
        ? { decision: "hold", reason: args.verdict.reason }
        : { decision: "hold" };
  }
}

export function emitDispatchesConsumed(args: {
  readonly stateRef: Ref.Ref<ServerState>;
  readonly lease: LeaseRecord;
  readonly messageId: string;
  readonly leaseIdOverride: string | null;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const writer = yield* moderatorWriter(args.stateRef);
    if (writer === null) return;
    yield* writer(
      encodeRawWireFrame({
        jsonrpc: "2.0",
        method: "dispatches/consumed",
        params: {
          dispatchId: args.lease.dispatchId,
          leaseId: args.leaseIdOverride ?? args.lease.leaseId,
          conversationId: args.lease.conversationId,
          messageId: args.messageId,
          consumedAt: "2026-01-01T00:00:00.003Z",
        },
      }),
    ).pipe(Effect.orDie);
  }).pipe(Effect.withSpan("emitDispatchesConsumed"));
}

export function emitDispatchesExpired(args: {
  readonly stateRef: Ref.Ref<ServerState>;
  readonly lease: LeaseRecord;
  readonly leaseIdOverride: string | null;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const writer = yield* moderatorWriter(args.stateRef);
    if (writer === null) return;
    yield* writer(
      encodeRawWireFrame({
        jsonrpc: "2.0",
        method: "dispatches/expired",
        params: {
          dispatchId: args.lease.dispatchId,
          leaseId: args.leaseIdOverride ?? args.lease.leaseId,
          conversationId: args.lease.conversationId,
          expiredAt: "2026-01-01T00:00:00.004Z",
        },
      }),
    ).pipe(Effect.orDie);
  }).pipe(Effect.withSpan("emitDispatchesExpired"));
}

function moderatorWriter(
  stateRef: Ref.Ref<ServerState>,
): Effect.Effect<((raw: string) => Effect.Effect<void, unknown>) | null> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    if (state.moderatorConnId === null) return null;
    return state.writers.get(state.moderatorConnId) ?? null;
  });
}

export function makeFakeMessage(
  conversationId: string,
  messageId?: string,
): unknown {
  return {
    id: messageId ?? freshUuidV4(),
    conversationId,
    senderId: "00000000-0000-4000-8000-000000000003",
    parts: [{ type: "text", text: "bad-server-stub" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

export function writeResponse(
  stateRef: Ref.Ref<ServerState>,
  connId: number,
  id: ResponseFrame["id"],
  body:
    | { result: unknown }
    | { error: { code: number; message: string; data?: unknown } },
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const writer = state.writers.get(connId);
    if (writer === undefined) return;
    yield* writer(encodeFrame(responseFrame(id, body))).pipe(Effect.orDie);
  }).pipe(Effect.withSpan("writeResponse"));
}
