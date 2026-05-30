import type { ServerRpcSlots } from "../../transport/context.js";
import {
  AppsRegister,
  DispatchRequest,
  DispatchesGet,
  ForbiddenError,
} from "@moltzap/protocol";
import { AppId } from "@moltzap/protocol/task";
import { Effect, Schema } from "effect";
import { AppHostTag, ConnectionTag } from "../layers.js";
import { defineAppMethod } from "../../transport/define-layered-method.js";
import { leaseRecordToWire } from "../../task/leases/lease-registry.js";

export const appHandlers: ServerRpcSlots = [
  defineAppMethod(AppsRegister, {
    callablePrincipal: "app",
    // A client-originated `apps/register` stores the calling WS
    // connection as the moderator endpoint for `manifest.appId`.
    // `dispatch/authorize` and `messages/authorize` route to this
    // socket via `sendRpcToClient`. The registry rejects overwrites
    // unconditionally (default app's inert endpoint OR a still-alive
    // wire connection blocks re-registration); reconnects work only after
    // the old connection's WS-close finalizer
    // (`unregisterAppsForConnection` via `socket-handler.ts →
    // closeSession`) clears the entry.
    handler: (params) =>
      Effect.gen(function* () {
        const appHost = yield* AppHostTag;
        const connection = yield* ConnectionTag;
        // D #705 CP4f — mint the `AppEndpoint` straight off the live
        // `Connection` arm (`{ connId, originator }` are `ConnectionBase`
        // fields on every arm). The legacy-map bridge is gone — the arm IS
        // the dispatch surface `AppHost` registers.
        // D #705 CP9 — this cross-principal WS RPC is being dissolved in favor
        // of `/api/v1/apps/register` (HTTP) + implicit registration on the
        // `appKey` Connect arm; until its consumers migrate it keeps its
        // legacy `manifest.appId` keying.
        const ok = appHost.registerApp(
          Schema.decodeUnknownSync(AppId)(params.manifest.appId),
          params.manifest,
          {
            connId: connection.connId,
            originator: connection.originator,
          },
        );
        if (!ok) {
          return yield* Effect.fail(
            new ForbiddenError({
              message: `App ${params.manifest.appId} is already registered`,
            }),
          );
        }
        return { appId: params.manifest.appId };
      }).pipe(Effect.withSpan("apps.register")),
  }),
  // `dispatch/request` — returns ack immediately, forks the moderator
  // round-trip, recipient observes the verdict via `dispatch/release`
  // notification.
  defineAppMethod(DispatchRequest, {
    // D #705 #720 — agent-called yet `defineAppMethod`-bound (the
    // orthogonality: `callablePrincipal: "agent"` for the table arm + ctx,
    // `defineAppMethod` for the `AppHostTag` R-channel bound). Reads
    // `ctx.agentId` as `recipientAgentId`; `requiresActive` fires on the
    // live agent arm and is load-bearing.
    callablePrincipal: "agent",
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
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
      }).pipe(Effect.withSpan("dispatch.request")),
  }),
  // `dispatches/get` — moderator-only read. Scope-enforced: the
  // calling connection MUST be the lease's `moderatorConnectionId`
  // (binding tuple recorded at `mint`). Otherwise typed
  // `ForbiddenError`.
  defineAppMethod(DispatchesGet, {
    callablePrincipal: "app",
    handler: (params) =>
      Effect.gen(function* () {
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
      }).pipe(Effect.withSpan("dispatches.get")),
  }),
];
