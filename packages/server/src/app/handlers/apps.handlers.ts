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

const DEFAULT_APP_SESSION_LIST_LIMIT = 50;

export function createAppHandlers(deps: {
  appHost: AppHost;
  permissionService?: DefaultPermissionService;
}): RpcMethodRegistry {
  return {
    [AppsRegister.name]: defineMethod(AppsRegister, {
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

    [AppsCreate.name]: defineMethod(AppsCreate, {
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

    [AppsAttestSkill.name]: defineMethod(AppsAttestSkill, {
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

    [PermissionsGrant.name]: defineMethod(PermissionsGrant, {
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

    [PermissionsList.name]: defineMethod(PermissionsList, {
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

    [PermissionsRevoke.name]: defineMethod(PermissionsRevoke, {
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

    [AppsCloseSession.name]: defineMethod(AppsCloseSession, {
      handler: (params, ctx) =>
        deps.appHost.closeSession(params.sessionId, ctx.agentId),
    }),

    [AppsGetSession.name]: defineMethod(AppsGetSession, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const session = yield* deps.appHost.getSession(
            params.sessionId,
            ctx.agentId,
          );
          return { session };
        }),
    }),

    [AppsListSessions.name]: defineMethod(AppsListSessions, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const sessions = yield* deps.appHost.listSessions(ctx.agentId, {
            appId: params.appId,
            status: params.status,
            limit: params.limit ?? DEFAULT_APP_SESSION_LIST_LIMIT,
          });
          return { sessions };
        }),
    }),

    // c2s wire handler for `apps/attachConversation` — architect plan §3.2 /
    // B.2 acceptance #3. Authorizes the caller as the session's
    // app-of-record via `requireSessionAppOfRecord`, then delegates to the
    // key-aware `attachConversation`. The wire schema does not carry a key
    // field; we use `conversationId` itself as the key — a deterministic
    // 1:1 mapping suitable for SDK callers that don't need a stable
    // human-readable handle (the in-process `attachAppConversation` API
    // remains for callers that do).
    //
    // Auth model (closes cross-tenant gap from codex review of PR #326):
    // The pre-recovery handler used `getSession(sessionId, ctx.agentId)`,
    // which admits ANY admitted participant — not just the app-of-record.
    // That was exploitable: any admitted participant could attach an
    // arbitrary conversationId, exfiltrating its messages through the
    // app's hooks and obtaining deny-veto on messages they shouldn't see.
    // The fixed check matches the caller's WS connection id against the
    // `registerRemoteApp` registration for `session.app_id` — only the
    // SDK connection that registered the app passes.
    //
    // Known partial: the architect plan §B.2 acceptance also names a typed
    // `ConversationNotFound` error code, but `attachConversation` does
    // not pre-check conversation existence; a missing conversationId
    // falls through to a Postgres FK violation, which the SDK reports as
    // `AttachFailed`. Tracked as B.2 follow-up issue #328.
    //
    // Conversation-membership defense (codex follow-up): a stricter
    // posture would also require the conversationId to be one this app
    // created (or already attached). The architect plan specifies only
    // session ownership + conversation existence; tracking convId→appId
    // ownership is a schema change that has to come from architect, not
    // senior. Filed as a ratchet escalation in the PR comment.
    [AppsAttachConversation.name]: defineMethod(AppsAttachConversation, {
      handler: (params) =>
        Effect.gen(function* () {
          // SessionNotFound (-32021) and Forbidden (-32001) round-trip to
          // `AttachError("SessionNotFound" | "NotAuthorized")` via the
          // numeric-code map in `app-sdk/src/app.ts:extractAttachCode`.
          const connId = yield* ConnIdTag;
          yield* deps.appHost.requireSessionAppOfRecord(
            params.sessionId,
            connId,
          );
          yield* deps.appHost.attachConversation(
            params.sessionId,
            params.conversationId,
            params.conversationId,
          );
          return {};
        }),
    }),

    [AppsAuthorizeDispatch.name]: defineMethod(AppsAuthorizeDispatch, {
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
