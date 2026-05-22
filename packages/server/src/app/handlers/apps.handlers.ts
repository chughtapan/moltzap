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
    // A client-originated `apps/register` writes a `Wire` registration
    // recording the calling connection. `dispatch/authorize` and
    // `messages/authorize` then route to this socket via
    // `sendRpcToClient`. Rejects with `ForbiddenError` if the appId is
    // already installed in-process (e.g. DEFAULT_APP_ID) — a wire
    // registration MUST NOT hijack a boot-installed app.
    handler: (params) =>
      Effect.gen(function* () {
        const appHost = yield* AppHostTag;
        const connId = yield* ConnIdTag;
        const ok = appHost.registerRemoteApp(params.manifest, connId);
        if (!ok) {
          return yield* Effect.fail(
            new ForbiddenError({
              message: `App ${params.manifest.appId} is already installed in-process`,
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
