import type { RpcMethodRegistry } from "../../transport/context.js";
import {
  AppsRegister,
  DispatchRequest,
  DispatchesGet,
  ForbiddenError,
} from "@moltzap/protocol";
import { Effect } from "effect";
import { AppHostTag, ConnIdTag } from "../layers.js";
import { defineAppMethod } from "../../transport/define-layered-method.js";
import { leaseRecordToWire } from "../lease-registry.js";

export const appHandlers: RpcMethodRegistry = [
  defineAppMethod(AppsRegister, {
    // A client-originated `apps/register` call records the calling
    // connection id so AppHost dispatches future `dispatch/authorize`
    // verbs via `sendRpcToClient` against this socket. If the client
    // constructed its `MoltZapWsClient` without a handler-table entry
    // for `dispatch/authorize`, the fail-CLOSED default slot replies
    // deny (per Spec F R2 / `optionalForbidden`) — same posture as a
    // crashed in-process handler. Server-side in-process registration
    // continues to use `coreApp.registerApp(manifest)` directly; that
    // path bypasses this RPC entirely.
    handler: (params) =>
      Effect.gen(function* () {
        const appHost = yield* AppHostTag;
        const connId = yield* ConnIdTag;
        appHost.registerRemoteApp(params.manifest, connId);
        return { appId: params.manifest.appId };
      }).pipe(Effect.withSpan("apps.register")),
  }),
  // `dispatch/request` — returns ack immediately, forks the moderator
  // round-trip, recipient observes the verdict via `dispatch/release`
  // notification.
  defineAppMethod(DispatchRequest, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const appHost = yield* AppHostTag;
        const connId = yield* ConnIdTag;
        const minted = yield* appHost.enqueueDispatchRequest({
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
      }).pipe(Effect.withSpan("dispatch.request")),
  }),
  // `dispatches/get` — moderator-only read. Scope-enforced: the
  // calling connection MUST be the lease's `moderatorConnectionId`
  // (binding tuple recorded at `mint`). Otherwise typed
  // `ForbiddenError`.
  defineAppMethod(DispatchesGet, {
    requiresActive: true,
    handler: (params) =>
      Effect.gen(function* () {
        const appHost = yield* AppHostTag;
        const connId = yield* ConnIdTag;
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
        if (record.binding.moderatorConnectionId !== connId) {
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
