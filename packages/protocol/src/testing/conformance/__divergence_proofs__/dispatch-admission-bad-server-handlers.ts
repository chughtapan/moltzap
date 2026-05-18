import { Duration, Effect, Either, Fiber, Ref } from "effect";
import type { RequestFrame, ResponseFrame } from "../../../transport/wire.js";
import { JSON_RPC_RESERVED_CODES } from "../../../transport/wire-errors.js";
import { Connect } from "../../../network/methods.js";
import { AppsRegister } from "../../../app/methods.js";
import {
  decodeFrame,
  isRequestFrame,
  isResponseFrame,
} from "../_shared/frame-mutator.js";
import type {
  AuthorizeWaiterMap,
  BadServerBehavior,
  HandleInboundFrameOpts,
  LeaseRecord,
  ModeratorVerdict,
  ModeratorWaiterResponse,
  ServerState,
} from "./dispatch-admission-bad-server-model.js";
import {
  FORBIDDEN_ERROR_CODE,
  SERIALIZE_DELAY_MS,
  badServerAgentId,
  encodeRawWireFrame,
  freshUuidV4,
} from "./dispatch-admission-bad-server-model.js";
import { resolveLease } from "./dispatch-admission-bad-server-resolution.js";
import {
  emitDispatchesConsumed,
  makeFakeMessage,
  makeLeaseRecordWire,
  writeResponse,
} from "./dispatch-admission-bad-server-wire.js";

export function handleInboundFrame(
  opts: HandleInboundFrameOpts,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const frame = yield* decodeFrame(opts.raw, "inbound").pipe(
      Effect.either,
      Effect.map(
        Either.match({
          onLeft: () => null,
          onRight: (value) => value,
        }),
      ),
    );
    if (frame === null) return;
    if (isResponseFrame(frame)) {
      yield* handleAuthorizeResponse({
        frame,
        authorizeWaiters: opts.authorizeWaiters,
      });
      return;
    }
    if (isRequestFrame(frame)) {
      yield* handleRequestFrame(frame, opts);
    }
  }).pipe(Effect.withSpan("handleInboundFrame"));
}

function handleRequestFrame(
  frame: RequestFrame,
  opts: HandleInboundFrameOpts,
): Effect.Effect<void> {
  if (frame.method === Connect.name) {
    return handleConnect({
      frame,
      connId: opts.connId,
      stateRef: opts.stateRef,
    });
  }
  if (frame.method === AppsRegister.name) {
    return handleAppsRegister({
      frame,
      connId: opts.connId,
      stateRef: opts.stateRef,
    });
  }
  return handleDomainRequestFrame(frame, opts);
}

function handleDomainRequestFrame(
  frame: RequestFrame,
  opts: HandleInboundFrameOpts,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    switch (frame.method) {
      case "tasks/create": {
        yield* handleTasksCreate(frame, opts);
        return;
      }
      case "tasks/createConversation": {
        yield* handleTasksCreateConversation(frame, opts);
        return;
      }
      case "conversations/addParticipant": {
        yield* handleAddParticipant(frame, opts);
        return;
      }
      case "messages/send": {
        yield* handleMessagesSend({ frame, connId: opts.connId, opts });
        return;
      }
      case "dispatches/get": {
        yield* handleDispatchesGet({ frame, connId: opts.connId, opts });
        return;
      }
      case "dispatch/request": {
        yield* handleDispatchRequest({ frame, connId: opts.connId, opts });
        return;
      }
      default: {
        yield* writeDefaultSuccess(frame, opts);
      }
    }
  });
}

function fallbackAgentId(state: ServerState, connId: number): string {
  return (
    state.agentByConn.get(connId) ?? "00000000-0000-4000-8000-000000000001"
  );
}

function handleTasksCreate(
  frame: RequestFrame,
  opts: HandleInboundFrameOpts,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(opts.stateRef);
    yield* writeResponse(opts.stateRef, opts.connId, frame.id, {
      result: yield* makeTaskResult(
        opts.stateRef,
        fallbackAgentId(state, opts.connId),
      ),
    });
  });
}

function handleTasksCreateConversation(
  frame: RequestFrame,
  opts: HandleInboundFrameOpts,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(opts.stateRef);
    yield* writeResponse(opts.stateRef, opts.connId, frame.id, {
      result: yield* makeConversationResult(
        opts.stateRef,
        fallbackAgentId(state, opts.connId),
      ),
    });
  });
}

function handleAddParticipant(
  frame: RequestFrame,
  opts: HandleInboundFrameOpts,
): Effect.Effect<void> {
  const params = frame.params as { participant?: { id?: unknown } };
  const participantAgentId =
    typeof params.participant?.id === "string"
      ? params.participant.id
      : "00000000-0000-4000-8000-000000000003";
  return writeResponse(opts.stateRef, opts.connId, frame.id, {
    result: makeAddParticipantResult(participantAgentId),
  });
}

function writeDefaultSuccess(
  frame: RequestFrame,
  opts: HandleInboundFrameOpts,
): Effect.Effect<void> {
  return writeResponse(opts.stateRef, opts.connId, frame.id, { result: {} });
}

// ── Request-method handlers ──────────────────────────────────────────

function handleConnect(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly stateRef: Ref.Ref<ServerState>;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const params = args.frame.params as { agentKey?: unknown };
    const apiKey = typeof params.agentKey === "string" ? params.agentKey : null;
    if (apiKey !== null) {
      // Map `apiKey → agentId` per the HTTP register's known issuance.
      // Because the bad-dispatch tests run with a single HTTP server
      // shared across the WS, we synthesize a stable agentId from the
      // key suffix.
      const match = /bad-server-key-(\d+)/.exec(apiKey);
      if (match !== null) {
        const counter = Number(match[1]);
        const agentId = badServerAgentId(counter);
        yield* Ref.update(args.stateRef, (s) => {
          s.agentByConn.set(args.connId, agentId);
          return s;
        });
      }
    }
    yield* writeResponse(args.stateRef, args.connId, args.frame.id, {
      result: {},
    });
  });
}

function handleAppsRegister(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly stateRef: Ref.Ref<ServerState>;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const params = args.frame.params as {
      manifest?: {
        appId?: unknown;
        hooks?: { dispatch_authorize?: { timeout_ms?: unknown } };
      };
    };
    const appId =
      typeof params.manifest?.appId === "string"
        ? params.manifest.appId
        : "bad-server-app";
    const timeoutMsRaw = params.manifest?.hooks?.dispatch_authorize?.timeout_ms;
    const moderatorTimeoutMs =
      typeof timeoutMsRaw === "number" && timeoutMsRaw > 0
        ? timeoutMsRaw
        : 5_000;
    yield* Ref.update(args.stateRef, (s) => {
      // The most-recent connection to call `apps/register` is the
      // moderator. Properties that loop `withDriver` mint fresh
      // moderator connections per iteration; tracking only the first
      // would leave subsequent iterations' dispatches/get without a
      // recognized authority.
      const agentId = s.agentByConn.get(args.connId) ?? null;
      s.moderatorAgentId = agentId;
      s.moderatorConnId = args.connId;
      s.moderatorResponseTimeoutMs = moderatorTimeoutMs;
      return s;
    });
    yield* writeResponse(args.stateRef, args.connId, args.frame.id, {
      result: { appId },
    });
  });
}

function makeTaskResult(
  stateRef: Ref.Ref<ServerState>,
  callerAgentId: string,
): Effect.Effect<unknown> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    return {
      task: {
        id: state.fixedTaskId,
        appId: "bad-server-app",
        initiatorAgentId: callerAgentId,
        status: "active",
        tmEndpointAddress: "ws://bad-server-tm",
        startedAt: null,
        endedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    };
  });
}

function makeConversationResult(
  stateRef: Ref.Ref<ServerState>,
  callerAgentId: string,
): Effect.Effect<unknown> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    return {
      conversation: {
        id: state.fixedConversationId,
        type: "group",
        name: "bad-server-conv",
        createdBy: callerAgentId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
  });
}

function makeAddParticipantResult(participantAgentId: string): unknown {
  return {
    participant: {
      conversationId: "00000000-0000-4000-8000-000000000c01",
      participant: {
        type: "agent",
        id: participantAgentId,
      },
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function handleMessagesSend(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly opts: HandleInboundFrameOpts;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const params = args.frame.params as MessageSendParams;
    const leaseId = messageSendLeaseId(params);
    if (leaseId === null) {
      yield* writeUnleasedMessage(args, params);
      return;
    }
    const lease = yield* findLeaseByLeaseId(args.opts.stateRef, leaseId);
    if (lease === null) {
      yield* writeLeaseInvalid(args, "PENDING");
      return;
    }
    yield* handleLeasedMessageSend(args, lease);
  });
}

interface MessageSendParams {
  readonly conversationId?: unknown;
  readonly dispatchLeaseId?: unknown;
}

interface MessageSendHandlerArgs {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly opts: HandleInboundFrameOpts;
}

function messageSendLeaseId(params: MessageSendParams): string | null {
  return typeof params.dispatchLeaseId === "string"
    ? params.dispatchLeaseId
    : null;
}

function writeUnleasedMessage(
  args: MessageSendHandlerArgs,
  params: MessageSendParams,
): Effect.Effect<void> {
  const conversationId =
    typeof params.conversationId === "string"
      ? params.conversationId
      : "00000000-0000-4000-8000-000000000c01";
  return writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
    result: { message: makeFakeMessage(conversationId) },
  });
}

function handleLeasedMessageSend(
  args: MessageSendHandlerArgs,
  lease: LeaseRecord,
): Effect.Effect<void> {
  switch (lease.state) {
    case "GRANTED":
      return consumeGrantedLease(args, lease);
    case "CONSUMED":
      return rejectConsumedLease(args, lease);
    case "EXPIRED":
      return writeLeaseInvalid(args, "EXPIRED");
    default:
      return writeLeaseInvalid(args, lease.state);
  }
}

function consumeGrantedLease(
  args: MessageSendHandlerArgs,
  lease: LeaseRecord,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const messageId = freshUuidV4();
    lease.state = "CONSUMED";
    lease.consumedMessageId = messageId;
    yield* interruptGrantTtlIfNeeded(args, lease);
    yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
      result: { message: makeFakeMessage(lease.conversationId, messageId) },
    });
    yield* emitDispatchesConsumed({
      stateRef: args.opts.stateRef,
      lease,
      messageId,
      leaseIdOverride:
        args.opts.behavior === "consumed-leaseid-mismatch"
          ? freshUuidV4()
          : null,
    });
  });
}

function interruptGrantTtlIfNeeded(
  args: { readonly opts: HandleInboundFrameOpts },
  lease: LeaseRecord,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (
      lease.expiryFiber !== null &&
      args.opts.behavior !== "expired-fires-after-consume"
    ) {
      yield* Fiber.interrupt(lease.expiryFiber);
      lease.expiryFiber = null;
    }
  });
}

function rejectConsumedLease(
  args: MessageSendHandlerArgs,
  lease: LeaseRecord,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* writeLeaseInvalid(args, "CONSUMED");
    if (args.opts.behavior === "consumed-fires-on-second-send") {
      yield* emitDispatchesConsumed({
        stateRef: args.opts.stateRef,
        lease,
        messageId: freshUuidV4(),
        leaseIdOverride: null,
      });
    }
  });
}

function writeLeaseInvalid(
  args: MessageSendHandlerArgs,
  state: LeaseRecord["state"],
): Effect.Effect<void> {
  return writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
    error: {
      code: FORBIDDEN_ERROR_CODE,
      message: "lease invalid",
      data: { state },
    },
  });
}

function handleDispatchesGet(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly opts: HandleInboundFrameOpts;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const params = args.frame.params as { dispatchId?: unknown };
    const dispatchId =
      typeof params.dispatchId === "string" ? params.dispatchId : null;
    const state = yield* Ref.get(args.opts.stateRef);
    if (args.connId !== state.moderatorConnId) {
      yield* rejectNonModeratorDispatchesGet(args);
      return;
    }
    if (dispatchId === null) {
      yield* writeDispatchesGetInvalidParams(args, "dispatchId required");
      return;
    }
    const lease = state.leases.get(dispatchId);
    if (lease === undefined) {
      yield* writeDispatchesGetInvalidParams(args, "lease not found");
      return;
    }
    yield* writeDispatchesGetLease(args, state, lease);
  });
}

function rejectNonModeratorDispatchesGet(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly opts: HandleInboundFrameOpts;
}): Effect.Effect<void> {
  const code =
    args.opts.behavior === "getlease-allow-non-moderator"
      ? JSON_RPC_RESERVED_CODES.InternalError
      : FORBIDDEN_ERROR_CODE;
  return writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
    error: {
      code,
      message: "non-moderator dispatches/get rejected",
    },
  });
}

function writeDispatchesGetInvalidParams(
  args: {
    readonly frame: RequestFrame;
    readonly connId: number;
    readonly opts: HandleInboundFrameOpts;
  },
  message: string,
): Effect.Effect<void> {
  return writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
    error: {
      code: JSON_RPC_RESERVED_CODES.InvalidParams,
      message,
    },
  });
}

function writeDispatchesGetLease(
  args: {
    readonly frame: RequestFrame;
    readonly connId: number;
    readonly opts: HandleInboundFrameOpts;
  },
  state: ServerState,
  lease: LeaseRecord,
): Effect.Effect<void> {
  const reportedLeaseId =
    args.opts.behavior === "getlease-leaseid-mismatch"
      ? freshUuidV4()
      : lease.leaseId;
  return writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
    result: {
      lease: makeLeaseRecordWire(lease, state, reportedLeaseId),
    },
  });
}

function findLeaseByLeaseId(
  stateRef: Ref.Ref<ServerState>,
  leaseId: string,
): Effect.Effect<LeaseRecord | null> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    for (const lease of state.leases.values()) {
      if (lease.leaseId === leaseId) return lease;
    }
    return null;
  });
}

// ── dispatch/request orchestration ───────────────────────────────────

function handleDispatchRequest(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly opts: HandleInboundFrameOpts;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const params = args.frame.params as DispatchRequestParams;
    const lease = yield* mintPendingLease(args, params);
    yield* maybeDelaySerializedAck(args.opts);
    yield* writeDispatchRequestAck(args, lease);
    yield* forkAuthorizeIfRequired(args, lease, params);
  });
}

interface DispatchRequestParams {
  readonly conversationId?: unknown;
  readonly messageId?: unknown;
  readonly senderAgentId?: unknown;
}

function mintPendingLease(
  args: { readonly connId: number; readonly opts: HandleInboundFrameOpts },
  params: DispatchRequestParams,
): Effect.Effect<LeaseRecord> {
  return Effect.gen(function* () {
    const dispatchId = freshUuidV4();
    const leaseId = yield* mintLeaseId(args.opts);
    const state = yield* Ref.get(args.opts.stateRef);
    const lease: LeaseRecord = {
      dispatchId,
      leaseId,
      recipientConnId: args.connId,
      recipientAgentId: state.agentByConn.get(args.connId) ?? "",
      conversationId: dispatchRequestConversationId(params),
      mintIndex: yield* nextMintIndex(args),
      state: "PENDING",
      verdict: null,
      consumedMessageId: null,
      leaseTimeoutMs: null,
      expiryFiber: null,
    };
    yield* Ref.update(args.opts.stateRef, (s) => {
      s.leases.set(dispatchId, lease);
      return s;
    });
    return lease;
  });
}

function dispatchRequestConversationId(params: DispatchRequestParams): string {
  return typeof params.conversationId === "string"
    ? params.conversationId
    : "00000000-0000-4000-8000-000000000c01";
}

function nextMintIndex(args: {
  readonly connId: number;
  readonly opts: HandleInboundFrameOpts;
}): Effect.Effect<number> {
  return Ref.modify(args.opts.mintCounterByRecipient, (m) => {
    const next = (m.get(args.connId) ?? 0) + 1;
    m.set(args.connId, next);
    return [next - 1, m] as const;
  });
}

function maybeDelaySerializedAck(
  opts: HandleInboundFrameOpts,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (opts.behavior !== "serialize-second-ack") return;
    const isSecond = yield* Ref.modify(
      opts.firstAckHeldRef,
      (held) => [held, true] as const,
    );
    if (isSecond) {
      yield* Effect.sleep(Duration.millis(SERIALIZE_DELAY_MS));
    }
  });
}

function writeDispatchRequestAck(
  args: {
    readonly frame: RequestFrame;
    readonly connId: number;
    readonly opts: HandleInboundFrameOpts;
  },
  lease: LeaseRecord,
): Effect.Effect<void> {
  const leaseId =
    args.opts.behavior === "ack-non-uuidv4-leaseid"
      ? "00000000-0000-1000-8000-000000000000"
      : lease.leaseId;
  return writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
    result: { leaseId, dispatchId: lease.dispatchId },
  });
}

function forkAuthorizeIfRequired(
  args: { readonly opts: HandleInboundFrameOpts },
  lease: LeaseRecord,
  params: DispatchRequestParams,
): Effect.Effect<void> {
  if (args.opts.behavior === "ack-non-uuidv4-leaseid") {
    return Effect.void;
  }
  return Effect.forkDaemon(
    orchestrateAuthorize({ lease, opts: args.opts, params }).pipe(
      Effect.ignore,
    ),
  ).pipe(Effect.asVoid);
}

function mintLeaseId(opts: HandleInboundFrameOpts): Effect.Effect<string> {
  return Effect.gen(function* () {
    if (opts.behavior === "lease-id-collision") {
      const existing = yield* Ref.get(opts.collisionLeaseIdRef);
      if (existing !== null) return existing;
      const fresh = freshUuidV4();
      yield* Ref.set(opts.collisionLeaseIdRef, fresh);
      return fresh;
    }
    return freshUuidV4();
  });
}

function orchestrateAuthorize(args: {
  readonly lease: LeaseRecord;
  readonly opts: HandleInboundFrameOpts;
  readonly params: DispatchRequestParams;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(args.opts.stateRef);
    if (state.moderatorConnId === null) {
      yield* denyLease(args, "no-moderator");
      return;
    }
    const moderatorWriter = state.writers.get(state.moderatorConnId);
    if (moderatorWriter === undefined) {
      yield* denyLease(args, "moderator-disconnected");
      return;
    }
    const verdictResult = yield* awaitModeratorReply({
      reqId: freshUuidV4(),
      writer: moderatorWriter,
      authorizeWaiters: args.opts.authorizeWaiters,
      lease: args.lease,
      params: args.params,
      moderatorAgentId: state.moderatorAgentId ?? "",
      taskId: state.fixedTaskId,
      timeoutMs: state.moderatorResponseTimeoutMs,
    });
    yield* resolveLease({
      lease: args.lease,
      opts: args.opts,
      verdict: verdictFromModeratorResult(verdictResult, args.opts.behavior),
    });
  });
}

function denyLease(
  args: { readonly lease: LeaseRecord; readonly opts: HandleInboundFrameOpts },
  reason: string,
): Effect.Effect<void> {
  return resolveLease({
    lease: args.lease,
    opts: args.opts,
    verdict: { _tag: "deny", reason },
  });
}

function verdictFromModeratorResult(
  result: ModeratorWaiterResponse | { readonly _tag: "timeout" },
  behavior: BadServerBehavior,
): ModeratorVerdict {
  if (result._tag === "ok") return result.value;
  return behavior === "synthesize-grant-on-timeout"
    ? { _tag: "grant" }
    : { _tag: "deny", reason: "timeout" };
}

function awaitModeratorReply(args: {
  readonly reqId: string;
  readonly writer: (raw: string) => Effect.Effect<void, unknown>;
  readonly authorizeWaiters: Ref.Ref<AuthorizeWaiterMap>;
  readonly lease: LeaseRecord;
  readonly params: DispatchRequestParams;
  readonly moderatorAgentId: string;
  readonly taskId: string;
  readonly timeoutMs: number;
}): Effect.Effect<ModeratorWaiterResponse | { readonly _tag: "timeout" }> {
  return Effect.gen(function* () {
    const promise = yield* installAuthorizeWaiter(args);
    yield* args.writer(makeAuthorizeRequestRaw(args)).pipe(Effect.orDie);
    return yield* waitForAuthorizeReply(args, promise);
  });
}

function makeAuthorizeRequestRaw(args: {
  readonly reqId: string;
  readonly lease: LeaseRecord;
  readonly params: DispatchRequestParams;
  readonly moderatorAgentId: string;
  readonly taskId: string;
}): string {
  return encodeRawWireFrame({
    jsonrpc: "2.0",
    id: args.reqId,
    method: "dispatch/authorize",
    params: {
      taskId: args.taskId,
      appId: "bad-server-app",
      conversationId: args.lease.conversationId,
      recipient: {
        agentId: args.lease.recipientAgentId,
        ownerId: "bad-server-owner",
      },
      message: {
        id: authorizeMessageId(args.params),
        senderAgentId: authorizeSenderAgentId(args),
      },
      attempt: 0,
    },
  });
}

function authorizeMessageId(params: DispatchRequestParams): string {
  return typeof params.messageId === "string"
    ? params.messageId
    : freshUuidV4();
}

function authorizeSenderAgentId(args: {
  readonly params: DispatchRequestParams;
  readonly moderatorAgentId: string;
}): string {
  return typeof args.params.senderAgentId === "string"
    ? args.params.senderAgentId
    : args.moderatorAgentId;
}

function installAuthorizeWaiter(args: {
  readonly reqId: string;
  readonly authorizeWaiters: Ref.Ref<AuthorizeWaiterMap>;
}): Effect.Effect<Promise<ModeratorWaiterResponse>> {
  return Effect.sync(
    () =>
      new Promise<ModeratorWaiterResponse>((resolve) => {
        Effect.runSync(
          Ref.update(args.authorizeWaiters, (m) => {
            m.set(args.reqId, resolve);
            return m;
          }),
        );
      }),
  );
}

function waitForAuthorizeReply(
  args: {
    readonly reqId: string;
    readonly authorizeWaiters: Ref.Ref<AuthorizeWaiterMap>;
    readonly timeoutMs: number;
  },
  promise: Promise<ModeratorWaiterResponse>,
): Effect.Effect<ModeratorWaiterResponse | { readonly _tag: "timeout" }> {
  return Effect.tryPromise({
    try: () => promise,
    catch: (err) => err,
  }).pipe(
    Effect.timeoutTo({
      duration: Duration.millis(args.timeoutMs),
      onTimeout: () => ({ _tag: "timeout" }) as const,
      onSuccess: (value) => value,
    }),
    Effect.catchAll(() =>
      Effect.succeed({ _tag: "error" as const, reason: "transport" }),
    ),
    Effect.ensuring(removeAuthorizeWaiter(args)),
  );
}

function removeAuthorizeWaiter(args: {
  readonly reqId: string;
  readonly authorizeWaiters: Ref.Ref<AuthorizeWaiterMap>;
}): Effect.Effect<void> {
  return Ref.update(args.authorizeWaiters, (m) => {
    m.delete(args.reqId);
    return m;
  });
}

function handleAuthorizeResponse(args: {
  readonly frame: ResponseFrame;
  readonly authorizeWaiters: Ref.Ref<AuthorizeWaiterMap>;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const id = args.frame.id;
    if (typeof id !== "string") return;
    const waiters = yield* Ref.get(args.authorizeWaiters);
    const resolve = waiters.get(id);
    if (resolve === undefined) return;
    if ("error" in args.frame) {
      resolve({ _tag: "error", reason: String(args.frame.error.code) });
      return;
    }
    const result = args.frame.result as {
      admission?: {
        decision?: unknown;
        leaseTimeoutMs?: unknown;
        reason?: unknown;
      };
    } | null;
    const verdict = parseVerdictFromAdmission(result?.admission);
    if (verdict === null) {
      resolve({ _tag: "error", reason: "unparseable-admission" });
      return;
    }
    resolve({ _tag: "ok", value: verdict });
  });
}

function parseVerdictFromAdmission(
  admission:
    | {
        readonly decision?: unknown;
        readonly leaseTimeoutMs?: unknown;
        readonly reason?: unknown;
      }
    | undefined,
): ModeratorVerdict | null {
  if (admission === undefined) return null;
  switch (admission.decision) {
    case "grant":
      return grantVerdict(admission.leaseTimeoutMs);
    case "deny":
      return reasonedVerdict("deny", admission.reason);
    case "hold":
      return reasonedVerdict("hold", admission.reason);
    default:
      return null;
  }
}

function grantVerdict(leaseTimeoutMs: unknown): ModeratorVerdict {
  return typeof leaseTimeoutMs === "number"
    ? { _tag: "grant", leaseTimeoutMs }
    : { _tag: "grant" };
}

function reasonedVerdict(
  tag: "deny" | "hold",
  reason: unknown,
): ModeratorVerdict {
  return typeof reason === "string" ? { _tag: tag, reason } : { _tag: tag };
}

// ── Connection close ─────────────────────────────────────────────────

export function onConnectionClose(args: {
  readonly connId: number;
  readonly stateRef: Ref.Ref<ServerState>;
  readonly authorizeWaiters: Ref.Ref<
    Map<
      string,
      (
        response:
          | { readonly _tag: "ok"; readonly value: ModeratorVerdict }
          | { readonly _tag: "error"; readonly reason: string }
          | { readonly _tag: "closed" },
      ) => void
    >
  >;
  readonly behavior: BadServerBehavior;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Ref.update(args.stateRef, (s) => {
      s.writers.delete(args.connId);
      s.agentByConn.delete(args.connId);
      // Default real-server contract: PENDING leases owned by this
      // recipient transition to ABANDONED. `no-abandon-on-disconnect`
      // skips the transition so the property's
      // `assertLeaseState(ABANDONED)` poll exhausts.
      if (args.behavior !== "no-abandon-on-disconnect") {
        for (const lease of s.leases.values()) {
          if (
            lease.recipientConnId === args.connId &&
            lease.state === "PENDING"
          ) {
            lease.state = "ABANDONED";
          }
        }
      }
      // If the moderator dropped, every outstanding S→C waiter resolves
      // closed so the orchestrator can synthesize a deny.
      if (args.connId === s.moderatorConnId) {
        s.moderatorConnId = null;
      }
      return s;
    });
  }).pipe(Effect.withSpan("onConnectionClose"));
}
