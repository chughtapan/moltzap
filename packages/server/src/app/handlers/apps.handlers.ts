import type { AppHost, DefaultPermissionService } from "../app-host.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import {
  AppsRegister,
  AppsCreate,
  AppsAttestSkill,
  AppsAttachConversation,
  PermissionsGrant,
  PermissionsList,
  PermissionsRevoke,
  AppsCloseSession,
  AppsGetSession,
  AppsListSessions,
  AppsAuthorizeDispatch,
} from "@moltzap/protocol";
import { Effect } from "effect";
import { ConnIdTag } from "../layers.js";
import { defineMethod } from "../../rpc/context.js";
import { ParticipantService } from "../../services/participant.service.js";

export function createAppHandlers(deps: {
  appHost: AppHost;
  permissionService?: DefaultPermissionService;
}): RpcMethodRegistry {
  return {
    "apps/register": defineMethod(AppsRegister, {
      // A c2s `apps/register` call means the connected client wants to
      // serve the app's hook RPCs (`apps/onBeforeDispatch`, etc.). We
      // record the calling connection id so AppHost dispatches future
      // hooks via `sendRpcToClient` against this socket. If the client
      // hasn't installed `client.handleServerRpc(...)` handlers, hook
      // RPCs will fail-closed (deny / block) — same posture as a
      // crashed in-process handler. Server-side in-process registration
      // continues to use `coreApp.registerApp(manifest)` directly (e.g.
      // standalone.ts:447); that path bypasses this RPC entirely.
      handler: (params) =>
        Effect.gen(function* () {
          const connId = yield* ConnIdTag;
          deps.appHost.registerRemoteApp(params.manifest, connId);
          return { appId: params.manifest.appId };
        }),
    }),

    "apps/create": defineMethod(AppsCreate, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const session = yield* deps.appHost.createSession(
            params.appId,
            ctx.agentId,
            params.invitedAgentIds,
          );
          return { session };
        }),
    }),

    "apps/attestSkill": defineMethod(AppsAttestSkill, {
      handler: (params, ctx) =>
        Effect.sync(() => {
          deps.appHost.resolveChallenge(
            params.challengeId,
            ctx.agentId,
            params.skillUrl,
            params.version,
          );
          return {};
        }),
    }),

    "permissions/grant": defineMethod(PermissionsGrant, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const ownerUserId = yield* ParticipantService.requireOwnerId(ctx);
          deps.permissionService?.resolvePermission(
            ownerUserId,
            params.sessionId,
            params.agentId,
            params.resource,
            params.access,
          );
          return {};
        }),
    }),

    "permissions/list": defineMethod(PermissionsList, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const ownerUserId = yield* ParticipantService.requireOwnerId(ctx);
          const grants = yield* deps.appHost.listGrants(
            ownerUserId,
            params.appId,
          );
          return { grants };
        }),
    }),

    "permissions/revoke": defineMethod(PermissionsRevoke, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const ownerUserId = yield* ParticipantService.requireOwnerId(ctx);
          yield* deps.appHost.revokeGrant(
            ownerUserId,
            params.appId,
            params.resource,
          );
          return {};
        }),
    }),

    "apps/closeSession": defineMethod(AppsCloseSession, {
      handler: (params, ctx) =>
        deps.appHost.closeSession(params.sessionId, ctx.agentId),
    }),

    "apps/getSession": defineMethod(AppsGetSession, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const session = yield* deps.appHost.getSession(
            params.sessionId,
            ctx.agentId,
          );
          return { session };
        }),
    }),

    "apps/listSessions": defineMethod(AppsListSessions, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const sessions = yield* deps.appHost.listSessions(ctx.agentId, {
            appId: params.appId,
            status: params.status,
            limit: params.limit ?? 50,
          });
          return { sessions };
        }),
    }),

    // c2s wire handler for `apps/attachConversation` — architect plan §3.2 /
    // B.2 acceptance #3. Authorizes the caller via `getSession` (returns
    // SessionNotFound or Forbidden so the SDK's `AttachError` round-trips
    // those tags) and then delegates to the key-aware
    // `attachConversation`. The wire schema does not carry a key field;
    // we use `conversationId` itself as the key — a deterministic 1:1
    // mapping suitable for SDK callers that don't need a stable
    // human-readable handle (the in-process `attachAppConversation` API
    // remains for callers that do).
    //
    // Known partial: the architect plan also names a typed
    // `ConversationNotFound` error code, but the underlying
    // `attachConversation` does not pre-check conversation existence;
    // a missing conversationId falls through to a Postgres FK violation,
    // which the SDK reports as `AttachFailed`. Tracked as a B.2 follow-up
    // (see PR body of #318).
    "apps/attachConversation": defineMethod(AppsAttachConversation, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          // Validates session existence + caller is initiator/admitted —
          // SessionNotFound (-32021) and Forbidden (-32001) round-trip to
          // `AttachError("SessionNotFound" | "NotAuthorized")` via the
          // numeric-code map in `app-sdk/src/app.ts:extractAttachCode`.
          yield* deps.appHost.getSession(params.sessionId, ctx.agentId);
          yield* deps.appHost.attachConversation(
            params.sessionId,
            params.conversationId,
            params.conversationId,
          );
          return {};
        }),
    }),

    "apps/authorizeDispatch": defineMethod(AppsAuthorizeDispatch, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const admission = yield* deps.appHost.runBeforeDispatch(
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
  };
}
