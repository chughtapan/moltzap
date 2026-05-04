import type { Kysely } from "kysely";
import type { AppSessionStatus, Database } from "../db/database.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager, MoltZapConnection } from "../ws/connection.js";
import { sendRpcToClient } from "../ws/connection.js";
import type { UserService } from "../services/user.service.js";
import { UserId } from "./types.js";
import { logger } from "../logger.js";
import type {
  AnyAppCallbackRpcDefinition,
  AppManifest,
  AppSession,
  LogicalClock,
  ParamsOf,
  Part,
  ResultOf,
} from "@moltzap/protocol";
import {
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnClose,
  AppsOnSessionActive,
  ErrorCodes,
  AppParticipantAdmittedNotificationDefinition,
  AppParticipantRejectedNotificationDefinition,
  AppSessionClosedNotificationDefinition,
  AppSessionFailedNotificationDefinition,
  AppSessionReadyNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  agentId as protocolAgentId,
  appSessionId,
  conversationId as protocolConversationId,
  messageId as protocolMessageId,
  notificationFrame,
} from "@moltzap/protocol";
import {
  type AppHooks,
  type BeforeDispatchContext,
  type BeforeDispatchHook,
  type BeforeMessageDeliveryContext,
  type BeforeMessageDeliveryHook,
  type DispatchAdmissionResult,
  type HookResult,
  type OnCloseContext,
  type OnCloseHook,
  type OnSessionActiveContext,
  type OnSessionActiveHook,
} from "./hooks.js";
import {
  Cause,
  Data,
  Deferred,
  Either,
  Effect,
  HashMap,
  Option,
  Ref,
} from "effect";
import { RpcFailure, coalesce, forbidden } from "../runtime/index.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOrFail,
  takeFirstOption,
  transaction,
} from "../db/effect-kysely-toolkit.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const MAX_AGENT_ADMISSION_CONCURRENCY = 16;
const MAX_AGENT_ADMISSION_CHECK_CONCURRENCY = 2;
const DEFAULT_APP_MAX_PARTICIPANTS = 50;
const DEFAULT_SESSION_LIST_LIMIT = 50;
const DEFAULT_APP_HOOK_TIMEOUT_MS = 5000;
const MSG_SESSION_NOT_FOUND = "Session not found";

function toProtocolConversationMap(
  conversations: Record<string, string>,
): AppSession["conversations"] {
  return Object.fromEntries(
    Object.entries(conversations).map(([key, id]) => [
      key,
      protocolConversationId(id),
    ]),
  );
}

export interface ContactService {
  areInContact(userIdA: string, userIdB: string): Effect.Effect<boolean, never>;
}

class RemoteHookError extends Data.TaggedError("RemoteHookError")<{
  readonly appId: string;
  readonly method: string;
  readonly connectionId: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

type RejectionStage = "user" | "identity";
type RejectionCode =
  | "UserInvalid"
  | "UserValidationFailed"
  | "AgentNotFound"
  | "AgentNoOwner"
  | "NotInContacts"
  | "ContactCheckFailed";

interface RejectionInfo {
  readonly stage: RejectionStage;
  readonly reason: string;
  readonly code: RejectionCode;
  readonly suggestedAction?: string;
}

export class AppHost {
  private manifests = new Map<string, AppManifest>();
  private contactService: ContactService | null = null;
  private hooks = new Map<string, AppHooks>();
  /**
   * Remote-app routing table. An entry exists iff `registerRemoteApp` was
   * called for `appId`; the value records which WS connection serves the
   * app's hook RPCs. Looked up at dispatch time (not registration time)
   * so the connection can be closed and re-resolved without re-registering
   * the app — the Scope finalizer on the old connection drains its
   * pending Deferreds with `AppDisconnected`, which the dispatch envelope
   * maps to fail-closed verdicts.
   *
   * Disjoint with `hooks` per-app: a given `appId` is either in-process
   * (entries in `hooks`) or remote (entry here), never both. The dispatch
   * helpers prefer the remote entry when present — `registerRemoteApp`
   * is the explicit promotion path.
   */
  private remoteRegistrations = new Map<string, { connectionId: string }>();
  private conversationToSession = new Map<
    string,
    { id: string; appId: string }
  >();
  private sessionToConversations = new Map<string, Set<string>>();

  constructor(
    private db: Kysely<Database>,
    private broadcaster: Broadcaster,
    private connections: ConnectionManager,
    /** null → no user validation (admit all owners). */
    private userService: UserService | null,
  ) {}

  registerApp(manifest: AppManifest): void {
    this.manifests.set(manifest.appId, manifest);
    logger.info({ appId: manifest.appId }, "App registered");
  }

  /**
   * Register an app whose hook handlers run in a remote process (typically
   * an `@moltzap/app-sdk` client connected over WebSocket). Hook RPCs
   * (`apps/onBeforeDispatch`, `onBeforeMessageDelivery`, `onSessionActive`,
   * `onClose`) are dispatched to `connectionId` via
   * {@link sendRpcToClient}; verdicts decode through the schemas defined in
   * `hooks.ts` and feed the same fail-closed envelope as in-process hooks.
   *
   * Promotion: a remote registration takes precedence over any prior
   * in-process hook registrations for the same `appId`. The
   * {@link AppRegistrationSource} discrimination is internal — call sites
   * (`runBeforeDispatch` / `runBeforeMessageDelivery` / etc.) consume one
   * uniform `Effect<Verdict, never>` regardless of source per architect
   * plan §3.4 ("No branching at the call site between in-process and
   * remote").
   *
   * Disconnect handling: when `connectionId` later goes away, every
   * pending Deferred for that connection's appCallback RPCs fails with
   * `AppDisconnected` via the connection's Scope finalizer. The dispatch
   * envelope catches `AppDisconnected` (and every other `AppCallbackRpcError`
   * variant) and synthesizes a fail-closed verdict — `deny` for
   * admission hooks, `block: true` for `before_message_delivery`, void +
   * log for lifecycle hooks. Callers do not need to
   * call {@link unregisterRemoteApp} on disconnect; the registration
   * keeps pointing at the dead connection id and dispatches keep
   * fail-closed until the app re-registers (typically via `apps/register`
   * after reconnecting). Operators that want eager cleanup can call
   * {@link unregisterRemoteApp} from a connection-close hook.
   */
  registerRemoteApp(manifest: AppManifest, connectionId: string): void {
    this.manifests.set(manifest.appId, manifest);
    this.remoteRegistrations.set(manifest.appId, { connectionId });
    logger.info(
      { appId: manifest.appId, connectionId },
      "Remote app registered",
    );
  }

  /**
   * Drop a remote-app registration. Idempotent — no-op if `appId` was not
   * previously registered as remote. Does NOT remove the manifest entry
   * (sessions and conversations may still reference it); callers that
   * want a full removal should also clear the manifest separately.
   *
   * Existing in-flight admission Deferreds are unaffected by this call —
   * they're owned by the connection's pending map and resolved either by
   * the response router (if the app replies) or by the Scope finalizer
   * on disconnect. Future dispatches for `appId` fall through to whatever
   * in-process hook is registered (or grant-by-default if none).
   */
  unregisterRemoteApp(appId: string): void {
    if (this.remoteRegistrations.delete(appId)) {
      logger.info({ appId }, "Remote app unregistered");
    }
  }

  /**
   * Authorize a wire caller as the app-of-record for a session.
   *
   * Architect plan §B.2 acceptance #2 — the wire handler for
   * `apps/attachConversation` "validates session ownership (caller's app
   * key matches `session.appId`)". On the wire, "caller's app key" is the
   * `connectionId` recorded by `registerRemoteApp` when the SDK sent
   * `apps/register`. This method resolves the session's `app_id` and
   * verifies the caller's connection is the registered remote-app
   * connection for that app.
   *
   * Errors:
   *   - {@link ErrorCodes.SessionNotFound} (-32021) when no row exists for
   *     `sessionId`. Wire SDK maps to `AttachError("SessionNotFound")`.
   *   - {@link ErrorCodes.Forbidden} (-32001) when the session exists but
   *     the caller is not the registered remote-app connection. Wire SDK
   *     maps to `AttachError("NotAuthorized")`.
   *
   * In-process app registrations have no `connectionId`; wire callers for
   * an in-process app receive Forbidden by construction. In-process call
   * sites must use `attachAppConversation` directly rather than the wire
   * RPC. This is intentional — the wire surface is the SDK's surface, and
   * the SDK only registers apps remotely.
   *
   * Closes the cross-tenant attach gap caught by codex on PR #326: a
   * non-app participant that `getSession` would admit (e.g., another
   * agent admitted to the same session) cannot satisfy this check, so
   * `apps/attachConversation` rejects them with Forbidden before any DB
   * mutation runs.
   */
  requireSessionAppOfRecord(
    sessionId: string,
    callerConnectionId: string,
  ): Effect.Effect<void, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const sessionRowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("app_sessions")
            .select(["id", "app_id"])
            .where("id", "=", sessionId),
        );
        if (Option.isNone(sessionRowOpt)) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.SessionNotFound,
              message: MSG_SESSION_NOT_FOUND,
            }),
          );
        }
        const remote = this.remoteRegistrations.get(sessionRowOpt.value.app_id);
        if (!remote || remote.connectionId !== callerConnectionId) {
          return yield* Effect.fail(
            forbidden(
              "Only the app of record can attach conversations to this session",
            ),
          );
        }
      }),
    );
  }

  getManifest(appId: string): AppManifest | undefined {
    return this.manifests.get(appId);
  }

  isAttachedToActiveSession(conversationId: string): boolean {
    return this.conversationToSession.has(conversationId);
  }

  setContactService(checker: ContactService): void {
    this.contactService = checker;
  }

  /**
   * Read-side accessor used by peer services (notably
   * {@link ConversationService}) that must consult the same contact policy
   * AppHost uses for app-session admission. Returns `null` when no policy
   * is wired — callers treat that as "allow all" to preserve dev-mode
   * defaults.
   */
  getContactService(): ContactService | null {
    return this.contactService;
  }

  onBeforeMessageDelivery(
    appId: string,
    handler: BeforeMessageDeliveryHook,
  ): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.beforeMessageDelivery = handler;
    this.hooks.set(appId, existing);
  }

  onBeforeDispatch(appId: string, handler: BeforeDispatchHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.beforeDispatch = handler;
    this.hooks.set(appId, existing);
  }

  onSessionClose(appId: string, handler: OnCloseHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.onClose = handler;
    this.hooks.set(appId, existing);
  }

  onSessionActive(appId: string, handler: OnSessionActiveHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.onSessionActive = handler;
    this.hooks.set(appId, existing);
  }

  runBeforeDispatch(
    conversationId: string,
    recipientAgentId: string,
    params: {
      messageId: string;
      senderAgentId: string;
      parts?: Part[];
      attempt?: number;
      receivedAt?: string;
      clock?: LogicalClock;
      pending?: ReadonlyArray<{
        messageId: string;
        conversationId: string;
        senderAgentId: string;
        createdAt: string;
        receivedAt: string;
        clock?: LogicalClock;
        parts?: Part[];
      }>;
    },
  ): Effect.Effect<DispatchAdmissionResult, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const session = this.conversationToSession.get(conversationId);
        if (!session) {
          const conversationOpt = yield* takeFirstOption(
            this.db
              .selectFrom("conversations")
              .select("archived_at")
              .where("id", "=", conversationId),
          );
          const conversation = Option.getOrNull(conversationOpt);
          if (conversation?.archived_at) {
            return {
              decision: "deny" as const,
              reason: "conversation_archived",
            };
          }
          return { decision: "grant" as const };
        }

        const isRemote = this.remoteRegistrations.has(session.appId);
        const appHooks = this.hooks.get(session.appId);

        if (!isRemote && !appHooks?.beforeDispatch) {
          return { decision: "grant" as const };
        }

        const agentOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select("owner_user_id")
            .where("id", "=", recipientAgentId),
        );
        const agent = Option.getOrNull(agentOpt);

        // ctx without `signal` — the in-process dispatch helper attaches
        // the AbortController-bound signal at call time. Remote dispatch
        // strips signal-shaped fields via `contextForWire` before encode.
        const ctx: BeforeDispatchContext = {
          conversationId,
          recipient: {
            agentId: recipientAgentId,
            ownerId: agent?.owner_user_id ?? "",
          },
          message: {
            id: params.messageId,
            senderAgentId: params.senderAgentId,
            parts: params.parts,
          },
          sessionId: session.id,
          appId: session.appId,
          attempt: params.attempt ?? 0,
          receivedAt: params.receivedAt,
          clock: params.clock,
          pending: params.pending,
          // Placeholder; the in-process dispatch helper overrides with
          // its own AbortController-tied signal. Remote dispatch elides.
          signal: new AbortController().signal,
        };

        // Uniform Effect dispatch — in-process / remote choice is INSIDE
        // the helper. Per architect plan §3.4: "No branching at the call
        // site between in-process and remote." Composition uses the
        // forEach-with-deny-short-circuit combinator (degenerate to N=1
        // today; forward-compatible for multi-app sessions).
        return yield* this.dispatchAcrossAppsWithDenyShortCircuit<DispatchAdmissionResult>(
          [session.appId],
          (v) => v.decision === "deny",
          { decision: "grant" as const },
          (appId) => this.dispatchBeforeDispatchHook(appId, ctx),
        );
      }),
    );
  }

  runBeforeMessageDelivery(
    conversationId: string,
    senderAgentId: string,
    parts: Part[],
    replyToId?: string,
    dispatchLeaseId?: string,
  ): Effect.Effect<{ result: HookResult; appId: string } | null, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const session = this.conversationToSession.get(conversationId);
        if (!session) return null;

        const isRemote = this.remoteRegistrations.has(session.appId);
        const appHooks = this.hooks.get(session.appId);

        if (!isRemote && !appHooks?.beforeMessageDelivery) {
          return null;
        }

        const agentOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select("owner_user_id")
            .where("id", "=", senderAgentId),
        );
        const agent = Option.getOrNull(agentOpt);

        const ctx: BeforeMessageDeliveryContext = {
          conversationId,
          sender: {
            agentId: senderAgentId,
            ownerId: agent?.owner_user_id ?? "",
          },
          message: { parts, replyToId, dispatchLeaseId },
          sessionId: session.id,
          appId: session.appId,
          // Placeholder; the in-process dispatch helper overrides with
          // its AbortController-tied signal. Remote dispatch elides via
          // `contextForWire`.
          signal: new AbortController().signal,
        };

        // Uniform Effect dispatch — in-process / remote choice INSIDE
        // the helper. Multi-app composition uses the forEach-with-block-
        // short-circuit combinator (degenerate to N=1 today).
        const result =
          yield* this.dispatchAcrossAppsWithDenyShortCircuit<HookResult>(
            [session.appId],
            (v) => v.block,
            { block: false },
            (appId) => this.dispatchBeforeMessageDeliveryHook(appId, ctx),
          );
        return { result, appId: session.appId };
      }),
    );
  }

  createSession(
    appId: string,
    initiatorAgentId: string,
    invitedAgentIds: string[],
  ): Effect.Effect<AppSession, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const manifest = this.manifests.get(appId);
        if (!manifest) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.AppNotFound,
              message: `Unknown app: ${appId}. Call registerApp({ appId: '${appId}', ... }) before creating sessions.`,
            }),
          );
        }

        const maxParticipants =
          manifest.limits?.maxParticipants ?? DEFAULT_APP_MAX_PARTICIPANTS;
        if (invitedAgentIds.length > maxParticipants) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.MaxParticipants,
              message: `Invited ${invitedAgentIds.length} agents but app limit is ${maxParticipants}`,
            }),
          );
        }

        const uniqueInvitedIds = [...new Set(invitedAgentIds)];
        const allAgentIds = [initiatorAgentId, ...uniqueInvitedIds];
        const agentRows = yield* this.db
          .selectFrom("agents")
          .select(["id", "owner_user_id", "status"])
          .where("id", "in", allAgentIds);

        const agentMap = new Map(agentRows.map((r) => [r.id, r]));

        const initiator = agentMap.get(initiatorAgentId);
        if (!initiator) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.AgentNotFound,
              message: "Initiator agent not found",
            }),
          );
        }
        if (!initiator.owner_user_id) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.AgentNoOwner,
              message:
                "Initiator agent has no owner_user_id. Agents must have an owner to participate in app sessions. Set owner_user_id on the agent.",
            }),
          );
        }

        // Validate initiator's user before persisting anything
        if (this.userService) {
          const { valid } = yield* this.userService.validateUser(
            UserId(initiator.owner_user_id),
          );
          if (!valid) {
            return yield* Effect.fail(
              forbidden("Initiator user failed validation"),
            );
          }
        }

        const sessionId = appSessionId(crypto.randomUUID());
        const conversationMap: Record<string, string> = {};

        yield* transaction(this.db, (trx) =>
          Effect.gen(this, function* () {
            for (const convDef of manifest.conversations ?? []) {
              const conv = yield* takeFirstOrFail(
                trx
                  .insertInto("conversations")
                  .values({
                    type: "group",
                    name: convDef.name,
                    created_by_id: initiatorAgentId,
                  })
                  .returningAll(),
              );

              conversationMap[convDef.key] = conv.id;

              yield* trx.insertInto("conversation_participants").values({
                conversation_id: conv.id,
                agent_id: initiatorAgentId,
                role: "owner",
              });

              this.subscribeToConversation(initiatorAgentId, conv.id);
            }

            const initialStatus =
              uniqueInvitedIds.length === 0 ? "active" : "waiting";
            yield* trx.insertInto("app_sessions").values({
              id: sessionId,
              app_id: appId,
              initiator_agent_id: initiatorAgentId,
              status: initialStatus,
              closed_at: null,
            });

            const convEntries = Object.entries(conversationMap);
            if (convEntries.length > 0) {
              yield* trx.insertInto("app_session_conversations").values(
                convEntries.map(([key, convId]) => ({
                  session_id: sessionId,
                  conversation_key: key,
                  conversation_id: convId,
                })),
              );
            }

            const knownInvitees = uniqueInvitedIds.filter((id) =>
              agentMap.has(id),
            );
            if (knownInvitees.length > 0) {
              yield* trx.insertInto("app_session_participants").values(
                knownInvitees.map((agentId) => ({
                  session_id: sessionId,
                  agent_id: agentId,
                  status: "pending" as const,
                  rejection_reason: null,
                  admitted_at: null,
                })),
              );
            }
          }),
        );

        const convIds = new Set<string>();
        for (const convId of Object.values(conversationMap)) {
          this.conversationToSession.set(convId, { id: sessionId, appId });
          convIds.add(convId);
        }
        this.sessionToConversations.set(sessionId, convIds);

        const session: AppSession = {
          id: sessionId,
          appId,
          initiatorAgentId: protocolAgentId(initiatorAgentId),
          status: uniqueInvitedIds.length === 0 ? "active" : "waiting",
          conversations: toProtocolConversationMap(conversationMap),
          createdAt: new Date().toISOString(),
        };

        if (uniqueInvitedIds.length === 0) {
          session.status = "active";
          this.broadcaster.sendToAgent(
            initiatorAgentId,
            notificationFrame(AppSessionReadyNotificationDefinition, {
              sessionId,
              conversations: toProtocolConversationMap(conversationMap),
            }),
          );
        } else {
          // Fire-and-forget background admission. forkDaemon detaches the fiber
          // from the current scope so it survives this request returning.
          yield* Effect.forkDaemon(
            this.admitAgentsAsync(
              session,
              manifest,
              initiatorAgentId,
              uniqueInvitedIds,
              agentMap,
            ),
          );
        }

        return session;
      }),
    );
  }

  closeSession(
    sessionId: string,
    callerAgentId: string,
  ): Effect.Effect<{ closed: boolean }, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const sessionRowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("app_sessions")
            .selectAll()
            .where("id", "=", sessionId),
        );

        const sessionRow = Option.getOrNull(sessionRowOpt);
        if (!sessionRow) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.SessionNotFound,
              message: MSG_SESSION_NOT_FOUND,
            }),
          );
        }
        if (sessionRow.status === "closed") {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.SessionClosed,
              message: "Session is already closed",
            }),
          );
        }

        if (sessionRow.initiator_agent_id !== callerAgentId) {
          return yield* Effect.fail(
            forbidden("Only the session initiator can close the session"),
          );
        }

        // Atomic claim: prevents concurrent close race.
        // Uses RETURNING instead of numUpdatedRows (PGlite compat).
        const claimed = yield* this.db
          .updateTable("app_sessions")
          .set({ status: "closed", closed_at: new Date() })
          .where("id", "=", sessionId)
          .where("status", "!=", "closed")
          .returning("id");
        if (claimed.length === 0) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.SessionClosed,
              message: "Session is already closed",
            }),
          );
        }

        const participantRows = yield* this.db
          .selectFrom("app_session_participants")
          .select("agent_id")
          .where("session_id", "=", sessionId)
          .where("status", "=", "admitted");
        const participantAgentIds = participantRows.map((r) => r.agent_id);

        const convEntries = yield* this.db
          .selectFrom("app_session_conversations")
          .select(["conversation_key", "conversation_id"])
          .where("session_id", "=", sessionId);
        const conversations: Record<string, string> = Object.fromEntries(
          convEntries.map((r) => [r.conversation_key, r.conversation_id]),
        );
        const convIds =
          this.sessionToConversations.get(sessionId) ??
          new Set(convEntries.map((r) => r.conversation_id));

        // Fire on_close hook with timeout (fail-open).
        const isRemote = this.remoteRegistrations.has(sessionRow.app_id);
        const appHooks = this.hooks.get(sessionRow.app_id);

        if (isRemote || appHooks?.onClose) {
          const initiatorOpt = yield* takeFirstOption(
            this.db
              .selectFrom("agents")
              .select("owner_user_id")
              .where("id", "=", callerAgentId),
          );
          const initiator = Option.getOrNull(initiatorOpt);
          const closedBy = {
            agentId: callerAgentId,
            ownerId: initiator?.owner_user_id ?? "",
          };

          // Uniform Effect dispatch — in-process / remote choice INSIDE
          // the helper. Fail-OPEN per architect plan §3.4.
          const ctx: OnCloseContext = {
            sessionId,
            appId: sessionRow.app_id,
            conversations,
            closedBy,
            signal: new AbortController().signal,
          };
          yield* this.dispatchOnCloseHook(sessionRow.app_id, ctx);
        }

        const convIdArray = [...convIds];
        const archivedAt = new Date();
        if (convIdArray.length > 0) {
          yield* this.db
            .updateTable("conversations")
            .set({ archived_at: archivedAt })
            .where("id", "in", convIdArray);
        }

        for (const convId of convIdArray) {
          this.broadcaster.broadcastToConversation(
            convId,
            notificationFrame(ConversationArchivedNotificationDefinition, {
              conversationId: protocolConversationId(convId),
              archivedAt: archivedAt.toISOString(),
              by: protocolAgentId(callerAgentId),
            }),
          );
        }

        for (const convId of convIdArray) {
          this.conversationToSession.delete(convId);
        }
        this.sessionToConversations.delete(sessionId);

        const allAgentIds = [callerAgentId, ...participantAgentIds];
        for (const agentId of allAgentIds) {
          for (const convId of convIdArray) {
            this.unsubscribeFromConversation(agentId, convId);
          }
        }

        const closedEvent = notificationFrame(
          AppSessionClosedNotificationDefinition,
          {
            sessionId: appSessionId(sessionId),
            closedBy: protocolAgentId(callerAgentId),
          },
        );
        this.broadcaster.sendToAgent(callerAgentId, closedEvent);
        for (const agentId of participantAgentIds) {
          this.broadcaster.sendToAgent(agentId, closedEvent);
        }

        return { closed: true };
      }),
    );
  }

  /**
   * Attach a dynamically-created conversation to an existing app session.
   *
   * Apps that create conversations outside the manifest (e.g. per-participant
   * role DMs inside an `on_session_active` handler) must register them with
   * `AppHost` so `before_message_delivery` fires on subsequent sends. Without
   * this call `conversationToSession.get(convId)` returns `undefined` and the
   * hook is silently skipped (see `runBeforeMessageDelivery`).
   *
   * Semantics:
   * - Validates the session exists and isn't closed.
   * - Idempotent on exact `(sessionId, conversationId, key)` match — a second
   *   identical call is a no-op.
   * - Errors if `key` is already used in the session under a different
   *   `conversationId`, or if `conversationId` is already attached to the
   *   session under a different `key`, or if `conversationId` is already
   *   attached to a *different* session.
   */
  attachConversation(
    sessionId: string,
    conversationId: string,
    key: string,
  ): Effect.Effect<void, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const sessionOpt = yield* takeFirstOption(
          this.db
            .selectFrom("app_sessions")
            .select(["id", "app_id", "status"])
            .where("id", "=", sessionId),
        );
        const session = Option.getOrNull(sessionOpt);
        if (!session) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.SessionNotFound,
              message: MSG_SESSION_NOT_FOUND,
            }),
          );
        }
        if (session.status === "closed") {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.SessionClosed,
              message: "Cannot attach a conversation to a closed session",
            }),
          );
        }

        // ConversationNotFound pre-check (architect plan §3.2 / §3.5):
        // surface a typed `ConversationNotFound` (-32002) when the convId
        // does not refer to any row in `conversations`. Without this the
        // bogus convId would fall through to the `app_session_conversations`
        // FK violation and surface to the SDK as the generic
        // `AttachError("AttachFailed")`, losing the structured tag.
        // Race-deleted conversations between this SELECT and the INSERT
        // below still surface as `AttachFailed` via FK violation; the
        // pre-check is best-effort, not a serializable invariant.
        const conversationOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select(["id"])
            .where("id", "=", conversationId),
        );
        if (Option.isNone(conversationOpt)) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.NotFound,
              message: "Conversation not found",
            }),
          );
        }

        // Cross-session collision: a convId can only belong to one session's
        // hook pipeline at a time (AppHost.conversationToSession is 1:1).
        const crossSession = this.conversationToSession.get(conversationId);
        if (crossSession && crossSession.id !== sessionId) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.Conflict,
              message: `Conversation ${conversationId} is already attached to session ${crossSession.id}`,
            }),
          );
        }

        // Single query covers both uniqueness checks: either the convId or the
        // key is already present for this session. At most two rows come back
        // (one per dimension) — bounded by the (session_id, conversation_key)
        // primary key and by the 1:1 cross-session invariant above.
        const existingRows = yield* this.db
          .selectFrom("app_session_conversations")
          .select(["conversation_key", "conversation_id"])
          .where("session_id", "=", sessionId)
          .where((eb) =>
            eb.or([
              eb("conversation_id", "=", conversationId),
              eb("conversation_key", "=", key),
            ]),
          );

        let convIdMatch: { conversation_key: string } | null = null;
        let keyMatch: { conversation_id: string } | null = null;
        for (const row of existingRows) {
          if (row.conversation_id === conversationId) convIdMatch = row;
          if (row.conversation_key === key) keyMatch = row;
        }

        if (
          convIdMatch &&
          keyMatch &&
          convIdMatch.conversation_key === key &&
          keyMatch.conversation_id === conversationId
        ) {
          // Exact (sessionId, convId, key) triple already recorded — no-op.
          // Refresh the in-memory maps in case they diverged from the DB
          // (e.g. after a server restart before a lazy rehydrate).
          this.conversationToSession.set(conversationId, {
            id: sessionId,
            appId: session.app_id,
          });
          const existingSet = this.sessionToConversations.get(sessionId);
          if (existingSet) existingSet.add(conversationId);
          else
            this.sessionToConversations.set(
              sessionId,
              new Set([conversationId]),
            );
          return;
        }

        if (convIdMatch && convIdMatch.conversation_key !== key) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.Conflict,
              message: `Conversation ${conversationId} is already attached to session ${sessionId} under key "${convIdMatch.conversation_key}"`,
            }),
          );
        }
        if (keyMatch && keyMatch.conversation_id !== conversationId) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.Conflict,
              message: `Conversation key "${key}" is already in use for session ${sessionId}`,
            }),
          );
        }

        yield* this.db.insertInto("app_session_conversations").values({
          session_id: sessionId,
          conversation_key: key,
          conversation_id: conversationId,
        });

        this.conversationToSession.set(conversationId, {
          id: sessionId,
          appId: session.app_id,
        });
        const convSet = this.sessionToConversations.get(sessionId);
        if (convSet) convSet.add(conversationId);
        else
          this.sessionToConversations.set(sessionId, new Set([conversationId]));
      }),
    );
  }

  getSession(
    sessionId: string,
    callerAgentId: string,
  ): Effect.Effect<AppSession, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const sessionRowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("app_sessions")
            .selectAll()
            .where("id", "=", sessionId),
        );

        if (Option.isNone(sessionRowOpt)) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.SessionNotFound,
              message: MSG_SESSION_NOT_FOUND,
            }),
          );
        }
        const sessionRow = sessionRowOpt.value;

        const isInitiator = sessionRow.initiator_agent_id === callerAgentId;
        if (!isInitiator) {
          const participantOpt = yield* takeFirstOption(
            this.db
              .selectFrom("app_session_participants")
              .select("status")
              .where("session_id", "=", sessionId)
              .where("agent_id", "=", callerAgentId),
          );
          const participant = Option.getOrNull(participantOpt);

          if (!participant || participant.status !== "admitted") {
            return yield* Effect.fail(
              forbidden(
                "Only the initiator or admitted participants can view this session",
              ),
            );
          }
        }

        const convRows = yield* this.db
          .selectFrom("app_session_conversations")
          .select(["conversation_key", "conversation_id"])
          .where("session_id", "=", sessionId);
        const conversations: Record<string, string> = Object.fromEntries(
          convRows.map((r) => [r.conversation_key, r.conversation_id]),
        );

        const session: AppSession = {
          id: appSessionId(sessionRow.id),
          appId: sessionRow.app_id,
          initiatorAgentId: protocolAgentId(sessionRow.initiator_agent_id),
          status: sessionRow.status,
          conversations: toProtocolConversationMap(conversations),
          createdAt: new Date(sessionRow.created_at).toISOString(),
        };
        if (sessionRow.closed_at) {
          session.closedAt = new Date(sessionRow.closed_at).toISOString();
        }
        return session;
      }),
    );
  }

  listSessions(
    callerAgentId: string,
    opts?: { appId?: string; status?: string; limit?: number },
  ): Effect.Effect<AppSession[], RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        let query = this.db
          .selectFrom("app_sessions")
          .selectAll()
          .where("initiator_agent_id", "=", callerAgentId)
          .orderBy("created_at", "desc");

        if (opts?.appId) {
          query = query.where("app_id", "=", opts.appId);
        }
        if (opts?.status) {
          query = query.where("status", "=", opts.status as AppSessionStatus);
        }

        const limit = opts?.limit ?? DEFAULT_SESSION_LIST_LIMIT;
        query = query.limit(limit);

        const rows = yield* query;

        return rows.map((row) => {
          const session: AppSession = {
            id: appSessionId(row.id),
            appId: row.app_id,
            initiatorAgentId: protocolAgentId(row.initiator_agent_id),
            status: row.status,
            conversations: {},
            createdAt: new Date(row.created_at).toISOString(),
          };
          if (row.closed_at) {
            session.closedAt = new Date(row.closed_at).toISOString();
          }
          return session;
        });
      }),
    );
  }

  /** Clear in-memory state. Called on shutdown. */
  destroy(): void {
    this.hooks.clear();
    this.remoteRegistrations.clear();
    this.conversationToSession.clear();
    this.sessionToConversations.clear();
  }

  private subscribeToConversation(agentId: string, convId: string): void {
    for (const conn of this.connections.getByAgent(agentId)) {
      conn.conversationIds.add(convId);
    }
  }

  private unsubscribeFromConversation(agentId: string, convId: string): void {
    for (const conn of this.connections.getByAgent(agentId)) {
      conn.conversationIds.delete(convId);
    }
  }

  // ── Uniform hook dispatch (in-process + remote) ────────────────────
  //
  // Per architect plan §3.4: every hook returns `Effect<Verdict, never>`
  // regardless of source. The branching between in-process and remote is
  // INSIDE the dispatch helpers; call sites observe one type. Failure
  // modes (timeout, throw, RPC error, AppDisconnected, decode failure)
  // collapse into fail-closed verdicts for admission hooks (`deny` /
  // `block`), or void + log for lifecycle hooks.
  //
  // Multi-app composition (architect plan §3.4: "Effect.forEach in
  // registration order, first deny short-circuits") is implemented by
  // {@link dispatchAcrossAppsWithDenyShortCircuit} below. Today every
  // session is bound to a single appId so the iteration is len-1; the
  // combinator is forward-compatible for multi-app sessions.

  /**
   * Strip non-wire-safe fields from a hook context so it can be sent over
   * the appCallback RPC. Currently the only such field is `signal: AbortSignal`,
   * which has meaning only in-process. Returns a new object — does not
   * mutate `ctx`.
   */
  private contextForWire<C extends { signal?: AbortSignal }>(
    ctx: C,
  ): Omit<C, "signal"> {
    // Type-checker insists we elide `signal` explicitly rather than using
    // a destructure-discard, because `signal` is optional in the constraint
    // but always present in the concrete contexts.
    const out = { ...ctx } as { signal?: AbortSignal } & Omit<C, "signal">;
    delete out.signal;
    return out;
  }

  private beforeDispatchParamsForWire(
    ctx: BeforeDispatchContext,
  ): ParamsOf<typeof AppsOnBeforeDispatch> {
    const wire = this.contextForWire(ctx);
    return {
      sessionId: wire.sessionId,
      appId: wire.appId,
      conversationId: protocolConversationId(wire.conversationId),
      recipient: {
        ...wire.recipient,
        agentId: protocolAgentId(wire.recipient.agentId),
      },
      message: {
        id: protocolMessageId(wire.message.id),
        senderAgentId: protocolAgentId(wire.message.senderAgentId),
        ...(wire.message.parts !== undefined
          ? { parts: wire.message.parts }
          : {}),
      },
      attempt: wire.attempt,
      ...(wire.receivedAt !== undefined ? { receivedAt: wire.receivedAt } : {}),
      ...(wire.clock !== undefined ? { clock: wire.clock } : {}),
      ...(wire.pending !== undefined
        ? {
            pending: wire.pending.map((pending) => ({
              messageId: protocolMessageId(pending.messageId),
              conversationId: protocolConversationId(pending.conversationId),
              senderAgentId: protocolAgentId(pending.senderAgentId),
              createdAt: pending.createdAt,
              receivedAt: pending.receivedAt,
              ...(pending.clock !== undefined ? { clock: pending.clock } : {}),
              ...(pending.parts !== undefined ? { parts: pending.parts } : {}),
            })),
          }
        : {}),
    };
  }

  private beforeMessageDeliveryParamsForWire(
    ctx: BeforeMessageDeliveryContext,
  ): ParamsOf<typeof AppsOnBeforeMessageDelivery> {
    const wire = this.contextForWire(ctx);
    return {
      sessionId: wire.sessionId,
      appId: wire.appId,
      conversationId: protocolConversationId(wire.conversationId),
      sender: {
        ...wire.sender,
        agentId: protocolAgentId(wire.sender.agentId),
      },
      message: {
        parts: wire.message.parts,
        ...(wire.message.dispatchLeaseId !== undefined
          ? { dispatchLeaseId: wire.message.dispatchLeaseId }
          : {}),
        ...(wire.message.replyToId !== undefined
          ? { replyToId: protocolMessageId(wire.message.replyToId) }
          : {}),
      },
    };
  }

  private onSessionActiveParamsForWire(
    ctx: OnSessionActiveContext,
  ): ParamsOf<typeof AppsOnSessionActive> {
    const wire = this.contextForWire(ctx);
    return {
      ...wire,
      conversations: toProtocolConversationMap(wire.conversations),
      admittedAgentIds: wire.admittedAgentIds.map(protocolAgentId),
    };
  }

  private onCloseParamsForWire(
    ctx: OnCloseContext,
  ): ParamsOf<typeof AppsOnClose> {
    const wire = this.contextForWire(ctx);
    return {
      ...wire,
      conversations: toProtocolConversationMap(wire.conversations),
      closedBy: {
        ...wire.closedBy,
        agentId: protocolAgentId(wire.closedBy.agentId),
      },
    };
  }

  /**
   * Run an in-process Promise-returning hook under an `AbortController`
   * tied to fiber interrupts (e.g., from `Effect.timeout` upstream). The
   * controller is wired so:
   *   - timeout fires → fiber interrupts → `Effect.onInterrupt` aborts
   *   - hook throws / rejects → `tapErrorCause` aborts
   * preserving the abort-on-timeout / abort-on-throw guarantees that
   * `30-app-hooks.integration.test.ts:359-435` covers.
   *
   * Returns the raw verdict in the success channel and a typed `Error`
   * in the failure channel (so the dispatch envelope's `catchAll` can
   * synthesize the fail-closed verdict).
   */
  private runInProcessHookEffect<Ctx, T>(
    handler: (ctx: Ctx & { signal: AbortSignal }) => T | Promise<T>,
    ctx: Ctx,
  ): Effect.Effect<T, Error> {
    return Effect.gen(function* () {
      const controller = new AbortController();
      return yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(handler({ ...ctx, signal: controller.signal })),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.tapErrorCause(() => Effect.sync(() => controller.abort())),
        Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
      );
    });
  }

  /**
   * Dispatch a server-initiated RPC to a remote app's connection and
   * decode the verdict. Returns the typed verdict in the success channel;
   * any failure (`AppDisconnected`, RPC response error, socket error,
   * schema decode failure, missing connection) lands in the failure
   * channel for the dispatch envelope to map to fail-closed.
   *
   * Result decoding happens in `sendRpcToClient`, where the descriptor
   * that constructed the frame validates the response against its TypeBox
   * result schema before this method can observe a value.
   */
  private runRemoteHookEffect<D extends AnyAppCallbackRpcDefinition>(opts: {
    appId: string;
    definition: D;
    connectionId: string;
    params: ParamsOf<D>;
  }): Effect.Effect<ResultOf<D>, RemoteHookError> {
    return Effect.gen(this, function* () {
      const method = opts.definition.name;
      const conn: MoltZapConnection | undefined = this.connections.get(
        opts.connectionId,
      );
      if (!conn) {
        // Stale registration: the remote app's connection has already
        // gone away. Treat identically to mid-flight `AppDisconnected`
        // so the dispatch envelope folds it into fail-closed.
        return yield* Effect.fail(
          new RemoteHookError({
            appId: opts.appId,
            method,
            connectionId: opts.connectionId,
            reason: `Remote app ${opts.appId} connection ${opts.connectionId} is gone`,
          }),
        );
      }
      return yield* sendRpcToClient(conn, opts.definition, opts.params).pipe(
        Effect.mapError(
          (err) =>
            new RemoteHookError({
              appId: opts.appId,
              method,
              connectionId: opts.connectionId,
              reason: `appCallback RPC failed: ${errorMessage(err)}`,
              cause: err,
            }),
        ),
      );
    });
  }

  /**
   * Apply the uniform timeout + fail-closed envelope to a raw hook
   * dispatch (in-process or remote). Three completion outcomes — totally
   * exhaustive over the wrapped Effect's behaviour:
   *
   *   - success → returns the verdict as-is.
   *   - `TimeoutException` (from `Effect.timeout`) → logs a warning via
   *     `Effect.logWarning`, returns the timeout verdict from `onTimeout`.
   *   - any other error (handler throw, RPC error, `AppDisconnected`,
   *     schema decode failure) → logs an error, returns the error
   *     verdict from `onError`.
   *
   * For admission hooks `onTimeout` / `onError` synthesize fail-closed
   * verdicts (`deny` / `block: true`); for lifecycle hooks they return
   * `Effect.void`. The error-channel narrowing to `never` is the
   * contract that lets call sites compose hooks via `Effect.forEach`
   * with no handler-error visibility.
   */
  private wrapHookEffectWithEnvelope<Verdict>(opts: {
    raw: Effect.Effect<Verdict, Error>;
    timeoutMs: number;
    timeoutLogMessage: string;
    timeoutLogContext: Record<string, unknown>;
    errorLogMessage: string;
    errorLogContext: Record<string, unknown>;
    onTimeout: () => Verdict;
    onError: () => Verdict;
  }): Effect.Effect<Verdict, never> {
    return opts.raw.pipe(
      Effect.timeout(`${opts.timeoutMs} millis`),
      Effect.catchTag("TimeoutException", () =>
        Effect.gen(function* () {
          yield* Effect.logWarning(opts.timeoutLogMessage).pipe(
            Effect.annotateLogs(opts.timeoutLogContext),
          );
          return opts.onTimeout();
        }),
      ),
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          yield* Effect.logError(opts.errorLogMessage).pipe(
            Effect.annotateLogs({
              ...opts.errorLogContext,
              err: errorMessage(err),
            }),
          );
          return opts.onError();
        }),
      ),
    );
  }

  /**
   * Uniform `before_dispatch` dispatch — the in-process / remote choice
   * is made HERE; callers see one signature and one return type. Returns
   * `{ decision: "grant" }` when no hook is registered. Fail-closed on
   * timeout / handler error / RPC failure per architect plan §3.4.
   */
  private dispatchBeforeDispatchHook(
    appId: string,
    ctx: BeforeDispatchContext,
  ): Effect.Effect<DispatchAdmissionResult, never> {
    const remote = this.remoteRegistrations.get(appId);
    const inProcess = this.hooks.get(appId)?.beforeDispatch;
    if (!remote && !inProcess) {
      return Effect.succeed({ decision: "grant" as const });
    }
    const manifest = this.manifests.get(appId);
    const timeoutMs =
      manifest?.hooks?.before_dispatch?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<DispatchAdmissionResult, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          definition: AppsOnBeforeDispatch,
          connectionId: remote.connectionId,
          params: this.beforeDispatchParamsForWire(ctx),
        }).pipe(Effect.map((envelope) => envelope.admission))
      : this.runInProcessHookEffect<
          BeforeDispatchContext,
          DispatchAdmissionResult
        >((ctxWithSignal) => inProcess!(ctxWithSignal), ctx);

    return this.wrapHookEffectWithEnvelope<DispatchAdmissionResult>({
      raw,
      timeoutMs,
      timeoutLogMessage: "before_dispatch hook timed out",
      timeoutLogContext: { sessionId, appId, timeoutMs },
      errorLogMessage: "before_dispatch hook error",
      errorLogContext: { sessionId, appId },
      onTimeout: () => ({
        decision: "deny" as const,
        reason: "before_dispatch hook timed out",
      }),
      onError: () => ({
        decision: "deny" as const,
        reason: "before_dispatch hook error",
      }),
    });
  }

  /**
   * Uniform `before_message_delivery` dispatch. Fail-CLOSED to
   * `{ block: true }` on timeout/throw/RPC-failure per architect plan §3.4
   * (verified against `30-app-hooks.integration.test.ts:229-272,296-357`).
   */
  private dispatchBeforeMessageDeliveryHook(
    appId: string,
    ctx: BeforeMessageDeliveryContext,
  ): Effect.Effect<HookResult, never> {
    const remote = this.remoteRegistrations.get(appId);
    const inProcess = this.hooks.get(appId)?.beforeMessageDelivery;
    if (!remote && !inProcess) {
      // No-hook short-circuit: caller treats `block: false` and no patch as
      // "pass through unchanged", same as the legacy `null` outcome.
      return Effect.succeed({ block: false });
    }
    const manifest = this.manifests.get(appId);
    const timeoutMs =
      manifest?.hooks?.before_message_delivery?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<HookResult, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          definition: AppsOnBeforeMessageDelivery,
          connectionId: remote.connectionId,
          params: this.beforeMessageDeliveryParamsForWire(ctx),
        })
      : this.runInProcessHookEffect<BeforeMessageDeliveryContext, HookResult>(
          (ctxWithSignal) => inProcess!(ctxWithSignal),
          ctx,
        );

    return this.wrapHookEffectWithEnvelope<HookResult>({
      raw,
      timeoutMs,
      timeoutLogMessage: "before_message_delivery hook timed out",
      timeoutLogContext: { sessionId, appId, timeoutMs },
      errorLogMessage: "before_message_delivery hook error",
      errorLogContext: { sessionId, appId },
      onTimeout: () => ({
        block: true,
        reason: "before_message_delivery hook timed out",
      }),
      onError: () => ({
        block: true,
        reason: "before_message_delivery hook error",
      }),
    });
  }

  /**
   * Uniform `on_session_active` dispatch — awaitable void with timeout.
   * Fail-OPEN: timeout/throw logs but the caller continues to broadcast
   * `app/sessionReady` (the ordering invariant verified by
   * `31-on-session-active.integration.test.ts:200-230`).
   */
  private dispatchOnSessionActiveHook(
    appId: string,
    ctx: OnSessionActiveContext,
  ): Effect.Effect<void, never> {
    const remote = this.remoteRegistrations.get(appId);
    const inProcess = this.hooks.get(appId)?.onSessionActive;
    if (!remote && !inProcess) return Effect.void;
    const manifest = this.manifests.get(appId);
    const timeoutMs =
      manifest?.hooks?.on_session_active?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<void, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          definition: AppsOnSessionActive,
          connectionId: remote.connectionId,
          params: this.onSessionActiveParamsForWire(ctx),
        })
      : this.runInProcessHookEffect<OnSessionActiveContext, void>(
          (ctxWithSignal) => inProcess!(ctxWithSignal),
          ctx,
        );

    return this.wrapHookEffectWithEnvelope<void>({
      raw,
      timeoutMs,
      timeoutLogMessage: "on_session_active hook timed out",
      timeoutLogContext: { sessionId, appId, timeoutMs },
      errorLogMessage: "on_session_active hook error",
      errorLogContext: { sessionId, appId },
      onTimeout: () => undefined,
      onError: () => undefined,
    });
  }

  /**
   * Uniform `on_close` dispatch — awaitable void with timeout. Fail-OPEN
   * per architect plan §3.4.
   */
  private dispatchOnCloseHook(
    appId: string,
    ctx: OnCloseContext,
  ): Effect.Effect<void, never> {
    const remote = this.remoteRegistrations.get(appId);
    const inProcess = this.hooks.get(appId)?.onClose;
    if (!remote && !inProcess) return Effect.void;
    const manifest = this.manifests.get(appId);
    const timeoutMs =
      manifest?.hooks?.on_close?.timeout_ms ?? DEFAULT_APP_HOOK_TIMEOUT_MS;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<void, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          definition: AppsOnClose,
          connectionId: remote.connectionId,
          params: this.onCloseParamsForWire(ctx),
        })
      : this.runInProcessHookEffect<OnCloseContext, void>(
          (ctxWithSignal) => inProcess!(ctxWithSignal),
          ctx,
        );

    return this.wrapHookEffectWithEnvelope<void>({
      raw,
      timeoutMs,
      timeoutLogMessage: "on_close hook timed out",
      timeoutLogContext: { sessionId, appId, timeoutMs },
      errorLogMessage: "on_close hook error",
      errorLogContext: { sessionId, appId },
      onTimeout: () => undefined,
      onError: () => undefined,
    });
  }

  /**
   * Compose admission verdicts across multiple registered apps for the
   * same hook in registration order, short-circuiting on the first
   * `deny` / `block`. Architect plan §3.4 names `Effect.forEach` as the
   * combinator; we use the equivalent sequential `Effect.gen` reduce so
   * the deny-as-short-circuit semantic reads at the call site without
   * needing a `catchTag` round-trip through a synthetic failure channel.
   *
   * Today every session is bound to a single appId so this is invoked
   * with a len-1 array; the helper exists so multi-app sessions slot in
   * without a call-site rewrite.
   */
  private dispatchAcrossAppsWithDenyShortCircuit<Verdict>(
    appIds: readonly string[],
    isShortCircuit: (v: Verdict) => boolean,
    defaultVerdict: Verdict,
    perApp: (appId: string) => Effect.Effect<Verdict, never>,
  ): Effect.Effect<Verdict, never> {
    return Effect.gen(function* () {
      let verdict: Verdict = defaultVerdict;
      for (const appId of appIds) {
        verdict = yield* perApp(appId);
        if (isShortCircuit(verdict)) return verdict;
      }
      return verdict;
    });
  }

  // ── Internal ───────────────────────────────────────────────────────

  private admitAgentsAsync(
    session: AppSession,
    manifest: AppManifest,
    initiatorAgentId: string,
    invitedAgentIds: string[],
    agentMap: Map<
      string,
      { id: string; owner_user_id: string | null; status: string }
    >,
  ): Effect.Effect<void, never> {
    // Runs as a daemon fiber (via Effect.forkDaemon at the caller).
    return Effect.gen(this, function* () {
      // Cache UserService results per ownerUserId to avoid redundant webhook
      // calls. Uses the `coalesce` helper so concurrent admitAgent fibers
      // for the same owner race-safely share one in-flight validateUser call
      // (see runtime/coalesce.ts).
      const userValidationCache = yield* Ref.make(
        HashMap.empty<string, Deferred.Deferred<{ valid: boolean }, never>>(),
      );

      // Run per-agent admissions concurrently, wrapping each in Exit to
      // preserve "collect all" semantics. Each element of `outcomes` reports
      // whether that agent was admitted or rejected.
      const outcomes = yield* Effect.all(
        invitedAgentIds.map((agentId) =>
          this.admitAgent(
            session,
            manifest,
            initiatorAgentId,
            agentId,
            agentMap,
            userValidationCache,
          ).pipe(
            Effect.matchCause({
              onFailure: (cause) => {
                logger.warn(
                  {
                    err: Cause.pretty(cause),
                    agentId,
                    sessionId: session.id,
                  },
                  "Agent admission failed",
                );
                return { agentId, status: "rejected" as const };
              },
              onSuccess: () => ({ agentId, status: "admitted" as const }),
            }),
          ),
        ),
        { concurrency: MAX_AGENT_ADMISSION_CONCURRENCY },
      );

      const allRejected = outcomes.every((o) => o.status === "rejected");
      const finalStatus = allRejected ? "failed" : "active";
      const admittedAgentIds = outcomes
        .filter((o) => o.status === "admitted")
        .map((o) => o.agentId);

      yield* this.db
        .updateTable("app_sessions")
        .set({ status: finalStatus })
        .where("id", "=", session.id)
        .pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError("Failed to update session status").pipe(
              Effect.annotateLogs({
                err: Cause.pretty(cause),
                sessionId: session.id,
              }),
            ),
          ),
        );

      if (allRejected) {
        this.broadcaster.sendToAgent(
          initiatorAgentId,
          notificationFrame(AppSessionFailedNotificationDefinition, {
            sessionId: session.id,
          }),
        );
        yield* Effect.logWarning("All agents rejected — session failed").pipe(
          Effect.annotateLogs({ sessionId: session.id }),
        );
      } else {
        // on_session_active fires once per session, after the status row is
        // active but BEFORE app/sessionReady is broadcast. Fail-open matches
        // on_close: timeout or handler throw logs, but admission still
        // completes and sessionReady still fires.
        yield* this.runOnSessionActive(session, admittedAgentIds);

        this.broadcaster.sendToAgent(
          initiatorAgentId,
          notificationFrame(AppSessionReadyNotificationDefinition, {
            sessionId: session.id,
            conversations: session.conversations,
          }),
        );
      }
    });
  }

  private runOnSessionActive(
    session: AppSession,
    admittedAgentIds: string[],
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      // Uniform Effect dispatch — in-process / remote choice INSIDE the
      // helper. Fail-OPEN: any timeout or error logs, but the caller still
      // proceeds to broadcast `app/sessionReady`, preserving the ordering
      // invariant covered by
      // 31-on-session-active.integration.test.ts:200-230.
      const ctx: OnSessionActiveContext = {
        sessionId: session.id,
        appId: session.appId,
        conversations: session.conversations,
        admittedAgentIds,
        signal: new AbortController().signal,
      };
      yield* this.dispatchOnSessionActiveHook(session.appId, ctx);
    });
  }

  private admitAgent(
    session: AppSession,
    manifest: AppManifest,
    initiatorAgentId: string,
    agentId: string,
    agentMap: Map<
      string,
      { id: string; owner_user_id: string | null; status: string }
    >,
    userValidationCache: Ref.Ref<
      HashMap.HashMap<string, Deferred.Deferred<{ valid: boolean }, never>>
    >,
  ): Effect.Effect<void, RpcFailure> {
    return Effect.gen(this, function* () {
      const agent = agentMap.get(agentId);
      if (!agent) {
        yield* this.rejectAgent(session.id, agentId, {
          stage: "identity",
          reason: "Agent not found",
          code: "AgentNotFound",
        });
        return yield* Effect.fail(
          new RpcFailure({
            code: ErrorCodes.AgentNotFound,
            message: "Agent not found",
          }),
        );
      }

      // User and identity checks are independent — run concurrently.
      // Track whether we've already rejected this agent so concurrent failures
      // don't send duplicate rejection events.
      let rejected = false;
      const guardedReject = (
        info: RejectionInfo,
      ): Effect.Effect<void, RpcFailure> => {
        if (rejected) return Effect.void;
        rejected = true;
        return this.rejectAgent(session.id, agentId, info);
      };

      // Run independent checks concurrently. `mode: "either"` collects every
      // outcome so one failure doesn't cancel the others — we want all errors
      // surfaced in the rejection log, then fail with the first.
      const checks: Effect.Effect<void, RpcFailure>[] = [
        this.checkIdentity(
          session,
          initiatorAgentId,
          agentId,
          agentMap,
          guardedReject,
        ),
      ];

      // User validation (coalesced per ownerUserId). Two concurrent
      // admitAgent fibers for agents owned by the same user share a
      // single in-flight validateUser call via `coalesce`; the Map-based
      // has/set pattern we used previously had a race where both fibers
      // could create separate Deferreds and fire redundant webhooks.
      if (this.userService && agent.owner_user_id) {
        const userId = UserId(agent.owner_user_id);
        const userService = this.userService;
        checks.push(
          Effect.gen(this, function* () {
            const { valid } = yield* coalesce(
              userValidationCache,
              userId,
              userService.validateUser(userId),
            );
            if (!valid) {
              yield* guardedReject({
                stage: "user",
                reason: "User validation failed",
                code: "UserInvalid",
              });
              return yield* Effect.fail(forbidden("User validation failed"));
            }
          }),
        );
      }

      const results = yield* Effect.all(checks, {
        concurrency: MAX_AGENT_ADMISSION_CHECK_CONCURRENCY,
        mode: "either",
      });

      for (const result of results) {
        const failure = Either.match(result, {
          onLeft: (err) => err,
          onRight: () => null,
        });
        if (failure !== null) {
          return yield* Effect.fail(failure);
        }
      }

      yield* this.admitAgentToSession(session, agentId);
    });
  }

  private checkIdentity(
    session: AppSession,
    initiatorAgentId: string,
    agentId: string,
    agentMap: Map<
      string,
      { id: string; owner_user_id: string | null; status: string }
    >,
    reject?: (info: RejectionInfo) => Effect.Effect<void, RpcFailure>,
  ): Effect.Effect<void, RpcFailure> {
    return Effect.gen(this, function* () {
      const doReject =
        reject ??
        ((info: RejectionInfo) => this.rejectAgent(session.id, agentId, info));

      const agent = agentMap.get(agentId)!;
      const initiator = agentMap.get(initiatorAgentId)!;

      if (!agent.owner_user_id) {
        yield* doReject({
          stage: "identity",
          reason: "Agent has no owner_user_id",
          suggestedAction:
            "Set owner_user_id on the agent before inviting it to app sessions",
          code: "AgentNoOwner",
        });
        return yield* Effect.fail(
          new RpcFailure({
            code: ErrorCodes.AgentNoOwner,
            message: "Agent has no owner",
          }),
        );
      }

      if (!this.contactService) return; // default: allow all

      const inContact = yield* this.contactService.areInContact(
        initiator.owner_user_id!,
        agent.owner_user_id!,
      );

      if (!inContact) {
        yield* doReject({
          stage: "identity",
          reason:
            "Agent owner is not a contact of the session initiator's owner",
          code: "NotInContacts",
        });
        return yield* Effect.fail(forbidden("Not in contacts"));
      }
    });
  }

  private admitAgentToSession(
    session: AppSession,
    agentId: string,
  ): Effect.Effect<void, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* this.db
          .updateTable("app_session_participants")
          .set({ status: "admitted", admitted_at: new Date() })
          .where("session_id", "=", session.id)
          .where("agent_id", "=", agentId);

        const manifest = this.manifests.get(session.appId)!;
        for (const convDef of manifest.conversations ?? []) {
          const filter = convDef.participantFilter ?? "all";
          const convId = session.conversations[convDef.key];
          if (!convId) continue;

          if (filter === "all") {
            yield* this.db
              .insertInto("conversation_participants")
              .values({
                conversation_id: convId,
                agent_id: agentId,
                role: "member",
              })
              .onConflict((oc) => oc.doNothing());

            this.subscribeToConversation(agentId, convId);
          }
        }

        const admittedEvent = notificationFrame(
          AppParticipantAdmittedNotificationDefinition,
          {
            sessionId: session.id,
            agentId: protocolAgentId(agentId),
          },
        );
        this.broadcaster.sendToAgent(agentId, admittedEvent);
        this.broadcaster.sendToAgent(session.initiatorAgentId, admittedEvent);

        yield* Effect.logInfo("Agent admitted to app session").pipe(
          Effect.annotateLogs({
            sessionId: session.id,
            agentId,
          }),
        );
      }),
    );
  }

  private rejectAgent(
    sessionId: string,
    agentId: string,
    info: RejectionInfo,
  ): Effect.Effect<void, RpcFailure> {
    const { stage, reason, code, suggestedAction } = info;
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* this.db
          .updateTable("app_session_participants")
          .set({ status: "rejected", rejection_reason: reason })
          .where("session_id", "=", sessionId)
          .where("agent_id", "=", agentId);

        this.broadcaster.sendToAgent(
          agentId,
          notificationFrame(AppParticipantRejectedNotificationDefinition, {
            sessionId: appSessionId(sessionId),
            agentId: protocolAgentId(agentId),
            reason,
            stage,
            suggestedAction,
            rejectionCode: code,
          }),
        );

        yield* Effect.logInfo("Agent rejected from app session").pipe(
          Effect.annotateLogs({
            sessionId,
            agentId,
            stage,
            reason,
            rejectionCode: code,
          }),
        );
      }),
    );
  }
}
