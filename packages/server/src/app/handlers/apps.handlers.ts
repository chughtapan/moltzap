import type { AppHost } from "../app-host.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import {
  AppsRegister,
  DispatchRequest,
  DispatchesGet,
  ForbiddenError,
} from "@moltzap/protocol";
import { Effect } from "effect";
import { ConnIdTag } from "../layers.js";
import { defineAppMethod } from "../../rpc/define-layered-method.js";
import { leaseRecordToWire } from "../lease-registry.js";

export function createAppHandlers(deps: {
  appHost: AppHost;
}): RpcMethodRegistry {
  return [
    defineAppMethod(AppsRegister, {
      // A client-originated `apps/register` call records the calling
      // connection id so AppHost dispatches future `dispatch/authorize`
      // verbs via `sendRpcToClient` against this socket. If the client
      // hasn't installed `client.handleServerRpc(...)` handlers, the
      // verb fails-closed (deny) — same posture as a crashed in-process
      // handler. Server-side in-process registration continues to use
      // `coreApp.registerApp(manifest)` directly; that path bypasses
      // this RPC entirely.
      handler: (params) =>
        Effect.gen(function* () {
          const connId = yield* ConnIdTag;
          deps.appHost.registerRemoteApp(params.manifest, connId);
          return { appId: params.manifest.appId };
        }),
    }),
    // `dispatch/request` — returns ack immediately, forks the moderator
    // round-trip, recipient observes the verdict via `dispatch/release`
    // notification.
    defineAppMethod(DispatchRequest, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const connId = yield* ConnIdTag;
          const minted = yield* deps.appHost.enqueueDispatchRequest({
            conversationId: params.conversationId,
            recipientAgentId: ctx.agentId,
            recipientConnectionId: connId,
            messageId: params.messageId,
            senderAgentId: params.senderAgentId,
            parts: params.parts,
            attempt: params.attempt,
            receivedAt: params.receivedAt,
            clock: params.clock,
            pending: params.pending,
          });
          return minted;
        }),
    }),
    // `dispatches/get` — moderator-only read. Scope-enforced: the
    // calling connection MUST be the lease's `moderatorConnectionId`
    // (binding tuple recorded at `mint`). Otherwise typed
    // `ForbiddenError`.
    defineAppMethod(DispatchesGet, {
      requiresActive: true,
      handler: (params) =>
        Effect.gen(function* () {
          const connId = yield* ConnIdTag;
          const registry = deps.appHost.getLeaseRegistry();
          if (!registry) {
            return yield* Effect.die(
              "AppHost.getLeaseRegistry returned null — registry not wired",
            );
          }
          const record = yield* registry
            .read({ _tag: "dispatchId", value: params.dispatchId })
            .pipe(
              Effect.mapError(
                () =>
                  new ForbiddenError({
                    message: "dispatches/get not authorized for this lease",
                  }),
              ),
            );
          if (record.binding.moderatorConnectionId !== connId) {
            return yield* Effect.fail(
              new ForbiddenError({
                message: "dispatches/get not authorized for this lease",
              }),
            );
          }
          return { lease: leaseRecordToWire(record) };
        }),
    }),
  ];
}
