import type { AgentContext } from "../../transport/context.js";
import {
  AppsRegister,
  DispatchRequest,
  DispatchesGet,
  AppsRegisterAuth,
  DispatchRequestAuth,
  DispatchesGetAuth,
  ForbiddenError,
  type ParamsOf,
} from "@moltzap/protocol";
import { AppId } from "@moltzap/protocol/task";
import { Effect, Schema } from "effect";
import { AppHostTag, ConnectionTag } from "../layers.js";
import { leaseRecordToWire } from "../../task/leases/lease-registry.js";
import { agentArm, toWireError } from "../native-handlers-runtime.js";

// A client-originated `apps/register` stores the calling WS connection as the
// moderator endpoint for `manifest.appId`. `dispatch/authorize` and
// `messages/authorize` route to this socket via `sendRpcToClient`. The registry
// rejects overwrites unconditionally (default app's inert endpoint OR a
// still-alive wire connection blocks re-registration); reconnects work only
// after the old connection's WS-close finalizer (`unregisterAppsForConnection`
// via `socket-handler.ts → closeSession`) clears the entry.
function appsRegisterBody(params: ParamsOf<typeof AppsRegister>) {
  return Effect.gen(function* () {
    const appHost = yield* AppHostTag;
    const connection = yield* ConnectionTag;
    // Mint the `AppEndpoint` straight off the live `Connection` arm
    // (`{ connId, originator }` are `ConnectionBase` fields on every arm) — the
    // arm IS the dispatch surface `AppHost` registers. This WS RPC keys by
    // `manifest.appId`; the HTTP `/api/v1/apps/register` route + `appKey`
    // Connect arm key by the server-minted `appId` instead.
    const ok = appHost.registerApp(
      Schema.decodeUnknownSync(AppId)(params.manifest.appId),
      params.manifest,
      { connId: connection.connId, originator: connection.originator },
    );
    if (!ok) {
      return yield* Effect.fail(
        new ForbiddenError({
          message: `App ${params.manifest.appId} is already registered`,
        }),
      );
    }
    return { appId: params.manifest.appId };
  }).pipe(Effect.withSpan("apps.register"));
}

// `dispatch/request` — returns ack immediately, forks the moderator round-trip,
// recipient observes the verdict via `dispatch/release` notification.
// Agent-called yet `defineAppMethod`-bound: `callablePrincipal: "agent"` for the
// ctx, `defineAppMethod` for the `AppHostTag` R-channel bound. Reads
// `ctx.agentId` as `recipientAgentId`; `requiresActive` is load-bearing.
function dispatchRequestBody(
  params: ParamsOf<typeof DispatchRequest>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const appHost = yield* AppHostTag;
    const connection = yield* ConnectionTag;
    const minted = yield* appHost.enqueueDispatchRequest({
      conversationId: params.conversationId,
      recipientAgentId: ctx.agentId,
      recipientConnectionId: connection.connId,
      messageId: params.messageId,
      senderAgentId: params.senderAgentId,
      parts: params.parts,
      attempt: params.attempt,
      receivedAt: params.receivedAt,
      clock: params.clock,
      pending: params.pending,
    });
    return minted;
  }).pipe(Effect.withSpan("dispatch.request"));
}

// `dispatches/get` — moderator-only read. Scope-enforced: the calling connection
// MUST be the lease's `moderatorConnectionId` (binding tuple recorded at
// `mint`). Otherwise typed `ForbiddenError`.
function dispatchesGetBody(params: ParamsOf<typeof DispatchesGet>) {
  return Effect.gen(function* () {
    const appHost = yield* AppHostTag;
    const connection = yield* ConnectionTag;
    const registry = appHost.getLeaseRegistry();
    if (!registry) {
      return yield* Effect.die(
        "AppHost.getLeaseRegistry returned null — registry not wired",
      );
    }
    const record = yield* registry
      .read({ _tag: "dispatchId", value: params.dispatchId })
      .pipe(
        Effect.catchTag("LeaseNotFoundError", () =>
          Effect.fail(
            new ForbiddenError({
              message: "dispatches/get not authorized for this lease",
            }),
          ),
        ),
      );
    if (record.binding.moderatorConnectionId !== connection.connId) {
      return yield* Effect.fail(
        new ForbiddenError({
          message: "dispatches/get not authorized for this lease",
        }),
      );
    }
    return { lease: leaseRecordToWire(record) };
  }).pipe(Effect.withSpan("dispatches.get"));
}


// ── Native @effect/rpc handler bodies ───────────────────────────────────────

export const nativeAppsRegister = (params: ParamsOf<typeof AppsRegister>) =>
  Effect.gen(function* () {
    yield* AppsRegisterAuth;
    return yield* appsRegisterBody(params);
  }).pipe(Effect.withSpan("nativeAppsRegister"), Effect.mapError(toWireError));

export const nativeDispatchRequest = (
  params: ParamsOf<typeof DispatchRequest>,
) =>
  Effect.gen(function* () {
    yield* DispatchRequestAuth;
    return yield* dispatchRequestBody(params, yield* agentArm);
  }).pipe(
    Effect.withSpan("nativeDispatchRequest"),
    Effect.mapError(toWireError),
  );

export const nativeDispatchesGet = (params: ParamsOf<typeof DispatchesGet>) =>
  Effect.gen(function* () {
    yield* DispatchesGetAuth;
    return yield* dispatchesGetBody(params);
  }).pipe(Effect.withSpan("nativeDispatchesGet"), Effect.mapError(toWireError));
