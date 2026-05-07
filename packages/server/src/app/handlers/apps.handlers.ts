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
    // `runAuthorizeDispatch` currently grants every conversation because
    // the `conversationToSession` map it consults has had no writers
    // since `apps/createSession` was deleted (see the dead-map comment
    // in `app-host.ts`). The handler stays for wire compatibility; the
    // map will be repopulated when this path is rewired to task→TM state.
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
