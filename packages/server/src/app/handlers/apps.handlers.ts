import type { AppHost } from "../app-host.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { AppsRegister, AppsAuthorizeDispatch } from "@moltzap/protocol";
import { Effect } from "effect";
import { ConnIdTag } from "../layers.js";
import { defineAppMethod } from "../../rpc/define-layered-method.js";

export function createAppHandlers(deps: {
  appHost: AppHost;
}): RpcMethodRegistry {
  return [
    defineAppMethod(AppsRegister, {
      // A client-originated `apps/register` call means the connected
      // client wants to serve the app's task-callback RPC
      // (`task/authorizeDispatch` post Phase 9b). We record the calling
      // connection id so AppHost dispatches future verbs via
      // `sendRpcToClient` against this socket. If the client hasn't
      // installed `client.handleServerRpc(...)` handlers, the verb
      // fails-closed (deny) — same posture as a crashed in-process
      // handler. Server-side in-process registration continues to use
      // `coreApp.registerApp(manifest)` directly (e.g.
      // standalone.ts:447); that path bypasses this RPC entirely.
      handler: (params) =>
        Effect.gen(function* () {
          const connId = yield* ConnIdTag;
          deps.appHost.registerRemoteApp(params.manifest, connId);
          return { appId: params.manifest.appId };
        }),
    }),
    // Phase 9b consumer-migration (sub-issue #460): the
    // channel→server `apps/authorizeDispatch` admission RPC stays as
    // the wire surface, but `runAuthorizeDispatch` currently returns
    // `{ decision: "grant" }` for every conversation because the
    // `conversationToSession` map it consults has had no writers since
    // Phase 7 deleted the `apps/createSession` flow. The kept handler
    // preserves wire compatibility for arena's channel runtime; Phase
    // 11 (arena cutover) is the natural seam to either rewire this
    // path to read task→TM state or delete the RPC entirely. See the
    // dead-map comment in `app-host.ts` for the deletion seam.
    defineAppMethod(AppsAuthorizeDispatch, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const admission = yield* deps.appHost.runAuthorizeDispatch(
            params.conversationId,
            ctx.agentId,
            {
              messageId: params.messageId,
              senderAgentId: params.senderAgentId,
              parts: params.parts,
              receivedAt: params.receivedAt,
              clock: params.clock,
              pending: params.pending,
              attempt: params.attempt,
            },
          );
          return { admission };
        }),
    }),
  ];
}
