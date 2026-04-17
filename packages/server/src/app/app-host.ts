import { createHmac } from "node:crypto";
import type { Kysely } from "kysely";
import type { AppSessionStatus, Database } from "../db/database.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager } from "../ws/connection.js";
import type { UserService } from "../services/user.service.js";
import { logger } from "../logger.js";
import type { AppManifest, AppSession, Part } from "@moltzap/protocol";
import { ErrorCodes, EventNames, eventFrame } from "@moltzap/protocol";
import type {
  AppHooks,
  BeforeMessageDeliveryHook,
  HookResult,
  OnCloseHook,
  OnJoinHook,
} from "./hooks.js";
import type { WebhookClient } from "../adapters/webhook.js";
import {
  Cause,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  HashMap,
  Option,
  Ref,
} from "effect";
import {
  RpcFailure,
  coalesce,
  drainCoalesceMap,
  forbidden,
} from "../runtime/index.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
  transaction,
} from "../db/effect-kysely-toolkit.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Compare two semver strings. Returns <0 if a<b, 0 if equal, >0 if a>b. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface ContactService {
  areInContact(userIdA: string, userIdB: string): Effect.Effect<boolean, never>;
}

export interface PermissionService {
  requestPermission(params: {
    userId: string;
    agentId: string;
    sessionId: string;
    appId: string;
    resource: string;
    access: string[];
    timeoutMs: number;
  }): Effect.Effect<string[], Error>;
}

export class PermissionDeniedError extends Data.TaggedError(
  "PermissionDenied",
)<{
  readonly resource: string;
}> {
  get message(): string {
    return `Permission denied for resource: ${this.resource}`;
  }
}

export class PermissionTimeoutError extends Data.TaggedError(
  "PermissionTimeout",
)<{
  readonly resource: string;
}> {
  get message(): string {
    return `Permission timeout for resource: ${this.resource}`;
  }
}

class AttestationTimeoutError extends Data.TaggedError("AttestationTimeout")<{
  readonly challengeId: string;
}> {
  get message(): string {
    return "attestation timeout";
  }
}

class SkillAttestationError extends Data.TaggedError("SkillAttestation")<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

interface PendingChallenge {
  targetAgentId: string;
  sessionId: string;
  resolve: (result: { skillUrl: string; version: string }) => void;
  reject: (reason: string) => void;
}

/**
 * Outcome of any hook dispatch (in-process OR webhook). Callers treat the
 * three variants uniformly:
 *
 *   - `{ result: T, timedOut: false }` — hook returned successfully
 *   - `{ result: null, timedOut: true }` — hook timed out (fail-closed)
 *   - `{ result: null, timedOut: false }` — hook threw / webhook error (fail-closed)
 *
 * Centralising the shape lets us swap in-process ↔ webhook dispatch without
 * changing the fail-closed plumbing in `runBeforeMessageDelivery` /
 * `closeSession` / `admitAgentToSession`.
 */
type HookOutcome<T> =
  | { result: T; timedOut: false }
  | { result: null; timedOut: true }
  | { result: null; timedOut: false };

interface PendingPermission {
  targetUserId: string;
  agentId: string;
  sessionId: string;
  appId: string;
  resource: string;
  resolve: (access: string[]) => void;
  reject: (reason: string) => void;
}

export class DefaultPermissionService implements PermissionService {
  private pendingPermissions = new Map<string, PendingPermission>();

  constructor(private broadcaster: Broadcaster) {}

  requestPermission(params: {
    userId: string;
    agentId: string;
    sessionId: string;
    appId: string;
    resource: string;
    access: string[];
    timeoutMs: number;
  }): Effect.Effect<string[], PermissionDeniedError | PermissionTimeoutError> {
    const key = `${params.sessionId}:${params.agentId}:${params.resource}`;

    // Await external resolution (grant/reject). Timeout lives OUTSIDE as
    // `Effect.timeoutFail` so it drives on the Effect Clock (TestClock-
    // drivable) — and reliably propagates through `coalesce` because the
    // coalesce helper restores interruptibility for the daemon body.
    const waitForResolution = Effect.async<string[], PermissionDeniedError>(
      (resume) => {
        const requestId = crypto.randomUUID();

        this.pendingPermissions.set(key, {
          targetUserId: params.userId,
          agentId: params.agentId,
          sessionId: params.sessionId,
          appId: params.appId,
          resource: params.resource,
          resolve: (access) => resume(Effect.succeed(access)),
          reject: (reason: string) =>
            resume(
              Effect.fail(new PermissionDeniedError({ resource: reason })),
            ),
        });

        this.broadcaster.sendToAgent(
          params.agentId,
          eventFrame(EventNames.PermissionsRequired, {
            sessionId: params.sessionId,
            appId: params.appId,
            resource: params.resource,
            access: params.access,
            requestId,
            targetUserId: params.userId,
          }),
        );

        return Effect.sync(() => {
          this.pendingPermissions.delete(key);
        });
      },
    );

    return waitForResolution.pipe(
      Effect.timeoutFail({
        duration: Duration.millis(params.timeoutMs),
        onTimeout: () =>
          new PermissionTimeoutError({ resource: params.resource }),
      }),
    );
  }

  resolvePermission(
    callerUserId: string,
    sessionId: string,
    agentId: string,
    resource: string,
    access: string[],
  ): void {
    const key = `${sessionId}:${agentId}:${resource}`;
    const pending = this.pendingPermissions.get(key);
    if (!pending) return;

    if (pending.targetUserId !== callerUserId) {
      logger.warn(
        {
          expected: pending.targetUserId,
          got: callerUserId,
          agentId,
          sessionId,
          resource,
        },
        "Permission grant from wrong user",
      );
      return;
    }

    this.pendingPermissions.delete(key);
    pending.resolve(access);
  }

  destroy(): void {
    for (const pending of this.pendingPermissions.values()) {
      // `reject(reason)` puts `reason` into PermissionDeniedError.resource,
      // which callers use to build UI copy. On shutdown the real resource
      // name preserves "permission denied for resource: X" shape rather
      // than producing "…for resource: shutdown". The outer
      // `Effect.timeoutFail` wrapper has no external timer to cancel.
      pending.reject(pending.resource);
    }
    this.pendingPermissions.clear();
  }
}

export class AppHost {
  private pendingChallenges = new Map<string, PendingChallenge>();
  private manifests = new Map<string, AppManifest>();
  private contactService: ContactService | null = null;
  private permissionService: PermissionService | null = null;
  private inflightPermissions = Effect.runSync(
    Ref.make(HashMap.empty<string, Deferred.Deferred<string[], Error>>()),
  );
  private hooks = new Map<string, AppHooks>();
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
    /**
     * Outbound HTTP client used to POST hook payloads to webhook URLs
     * declared in {@link AppManifest.hooks}. Always present (core wires a
     * default instance) — null would force callers to branch on every hook
     * path, which we deliberately avoid.
     */
    private webhookClient: WebhookClient,
  ) {}

  registerApp(manifest: AppManifest): void {
    this.manifests.set(manifest.appId, manifest);
    this.warnOnHookConfigConflict(manifest);
    logger.info({ appId: manifest.appId }, "App registered");
  }

  /**
   * Precedence rule (documented in docs/guides/app-hooks.mdx):
   *
   *   webhook URL > in-process handler > no hook
   *
   * If both are configured for the same hook on the same appId, log a
   * warning. The dispatch path picks the webhook; the in-process handler
   * is silently ignored. We do NOT reject at registration — the manifest
   * is loaded from config/yaml and the app layer may register the
   * handler later at runtime, so the two-arg order is not observable
   * from here.
   */
  private warnOnHookConfigConflict(manifest: AppManifest): void {
    const hooks = manifest.hooks;
    if (!hooks) return;
    const existing = this.hooks.get(manifest.appId);
    const pairs: Array<{
      hookName: string;
      webhookSet: boolean;
      inProcessSet: boolean;
    }> = [
      {
        hookName: "before_message_delivery",
        webhookSet: Boolean(hooks.before_message_delivery?.webhook),
        inProcessSet: Boolean(existing?.beforeMessageDelivery),
      },
      {
        hookName: "on_join",
        webhookSet: Boolean(hooks.on_join?.webhook),
        inProcessSet: Boolean(existing?.onJoin),
      },
      {
        hookName: "on_close",
        webhookSet: Boolean(hooks.on_close?.webhook),
        inProcessSet: Boolean(existing?.onClose),
      },
    ];
    for (const p of pairs) {
      if (p.webhookSet && p.inProcessSet) {
        logger.warn(
          { appId: manifest.appId, hookName: p.hookName },
          "Both webhook URL and in-process handler configured; webhook takes precedence",
        );
      }
    }
  }

  getManifest(appId: string): AppManifest | undefined {
    return this.manifests.get(appId);
  }

  setContactService(checker: ContactService): void {
    this.contactService = checker;
  }

  setPermissionService(handler: PermissionService): void {
    this.permissionService = handler;
  }

  onBeforeMessageDelivery(
    appId: string,
    handler: BeforeMessageDeliveryHook,
  ): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.beforeMessageDelivery = handler;
    this.hooks.set(appId, existing);
    this.warnIfWebhookConfigured(appId, "before_message_delivery");
  }

  onAppJoin(appId: string, handler: OnJoinHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.onJoin = handler;
    this.hooks.set(appId, existing);
    this.warnIfWebhookConfigured(appId, "on_join");
  }

  onSessionClose(appId: string, handler: OnCloseHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.onClose = handler;
    this.hooks.set(appId, existing);
    this.warnIfWebhookConfigured(appId, "on_close");
  }

  /**
   * Log a warning when an in-process handler is registered for a hook
   * that already has a webhook URL in the manifest. Complements
   * {@link warnOnHookConfigConflict} which fires in the other order.
   */
  private warnIfWebhookConfigured(
    appId: string,
    hookName: "before_message_delivery" | "on_join" | "on_close",
  ): void {
    const manifest = this.manifests.get(appId);
    if (!manifest?.hooks) return;
    const webhook = manifest.hooks[hookName]?.webhook;
    if (webhook) {
      logger.warn(
        { appId, hookName },
        "In-process hook registered but manifest declares a webhook URL; webhook takes precedence",
      );
    }
  }

  runBeforeMessageDelivery(
    conversationId: string,
    senderAgentId: string,
    parts: Part[],
    replyToId?: string,
  ): Effect.Effect<{ result: HookResult; appId: string } | null, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const session = this.conversationToSession.get(conversationId);
        if (!session) return null;

        const manifest = this.manifests.get(session.appId);
        const webhookUrl = manifest?.hooks?.before_message_delivery?.webhook;
        const appHooks = this.hooks.get(session.appId);

        // Dispatch precedence: webhook > in-process handler > no hook.
        if (!webhookUrl && !appHooks?.beforeMessageDelivery) return null;

        const agentOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select("owner_user_id")
            .where("id", "=", senderAgentId),
        );
        const agent = Option.getOrNull(agentOpt);

        const ctx = {
          conversationId,
          sender: {
            agentId: senderAgentId,
            ownerId: agent?.owner_user_id ?? "",
          },
          message: { parts, replyToId },
          sessionId: session.id,
          appId: session.appId,
        };

        const timeoutMs =
          manifest?.hooks?.before_message_delivery?.timeout_ms ?? 5000;

        const outcome: HookOutcome<HookResult> = webhookUrl
          ? yield* this.dispatchWebhookHook<HookResult>({
              url: webhookUrl,
              event: "app.before_message_delivery",
              secret: manifest?.hooks?.secret,
              body: {
                sessionId: session.id,
                appId: session.appId,
                conversationId: ctx.conversationId,
                sender: ctx.sender,
                message: ctx.message,
              },
              timeoutMs,
            })
          : yield* this.runHookWithTimeout<HookResult>(
              (signal) => appHooks!.beforeMessageDelivery!({ ...ctx, signal }),
              timeoutMs,
            );

        // Fail-closed policy: on hook timeout or hook exception, synthesize
        // a `{ block: true }` result so security/moderation hooks cannot be
        // bypassed by a slow or crashing handler. Operator sees the
        // `app/hookTimeout` event on the conversation.
        if (outcome.timedOut) {
          this.broadcaster.sendToAgent(
            ctx.sender.agentId,
            eventFrame("app/hookTimeout", {
              sessionId: session.id,
              appId: session.appId,
              hookName: "before_message_delivery",
              timeoutMs,
            }),
          );
          yield* Effect.logWarning(
            "before_message_delivery hook timed out",
          ).pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              appId: session.appId,
              timeoutMs,
            }),
          );
          return {
            result: {
              block: true,
              reason: "before_message_delivery hook timed out",
            },
            appId: session.appId,
          };
        }

        if (!outcome.result) {
          // Hook threw — `runHookWithTimeout` / `dispatchWebhookHook` already
          // logged via `Effect.logError`. Block the message rather than
          // silently passing it through.
          return {
            result: {
              block: true,
              reason: "before_message_delivery hook error",
            },
            appId: session.appId,
          };
        }

        return { result: outcome.result, appId: session.appId };
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

        const maxParticipants = manifest.limits?.maxParticipants ?? 50;
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
            initiator.owner_user_id,
          );
          if (!valid) {
            return yield* Effect.fail(
              forbidden("Initiator user failed validation"),
            );
          }
        }

        const sessionId = crypto.randomUUID();
        const conversationMap: Record<string, string> = {};

        // #ignore-sloppy-code-next-line[async-keyword]: Kysely transaction callback contract
        yield* transaction(this.db, async (trx) => {
          for (const convDef of manifest.conversations ?? []) {
            const conv = await trx
              .insertInto("conversations")
              .values({
                type: "group",
                name: convDef.name,
                created_by_id: initiatorAgentId,
              })
              .returningAll()
              .executeTakeFirstOrThrow();

            conversationMap[convDef.key] = conv.id;

            await trx
              .insertInto("conversation_participants")
              .values({
                conversation_id: conv.id,
                agent_id: initiatorAgentId,
                role: "owner",
              })
              .execute();

            this.subscribeToConversation(initiatorAgentId, conv.id);
          }

          const initialStatus =
            uniqueInvitedIds.length === 0 ? "active" : "waiting";
          await trx
            .insertInto("app_sessions")
            .values({
              id: sessionId,
              app_id: appId,
              initiator_agent_id: initiatorAgentId,
              status: initialStatus,
              closed_at: null,
            })
            .execute();

          const convEntries = Object.entries(conversationMap);
          if (convEntries.length > 0) {
            await trx
              .insertInto("app_session_conversations")
              .values(
                convEntries.map(([key, convId]) => ({
                  session_id: sessionId,
                  conversation_key: key,
                  conversation_id: convId,
                })),
              )
              .execute();
          }

          const knownInvitees = uniqueInvitedIds.filter((id) =>
            agentMap.has(id),
          );
          if (knownInvitees.length > 0) {
            await trx
              .insertInto("app_session_participants")
              .values(
                knownInvitees.map((agentId) => ({
                  session_id: sessionId,
                  agent_id: agentId,
                  status: "pending" as const,
                  rejection_reason: null,
                  admitted_at: null,
                })),
              )
              .execute();
          }
        });

        const convIds = new Set<string>();
        for (const convId of Object.values(conversationMap)) {
          this.conversationToSession.set(convId, { id: sessionId, appId });
          convIds.add(convId);
        }
        this.sessionToConversations.set(sessionId, convIds);

        const session: AppSession = {
          id: sessionId,
          appId,
          initiatorAgentId,
          status: uniqueInvitedIds.length === 0 ? "active" : "waiting",
          conversations: conversationMap,
          createdAt: new Date().toISOString(),
        };

        if (uniqueInvitedIds.length === 0) {
          session.status = "active";
          this.broadcaster.sendToAgent(
            initiatorAgentId,
            eventFrame("app/sessionReady", {
              sessionId,
              conversations: conversationMap,
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

  resolveChallenge(
    challengeId: string,
    callerAgentId: string,
    skillUrl: string,
    version: string,
  ): void {
    const pending = this.pendingChallenges.get(challengeId);
    if (!pending) return; // expired or unknown

    if (pending.targetAgentId !== callerAgentId) {
      logger.warn(
        { challengeId, expected: pending.targetAgentId, got: callerAgentId },
        "Skill attestation from wrong agent",
      );
      return;
    }

    this.pendingChallenges.delete(challengeId);
    pending.resolve({ skillUrl, version });
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
              message: "Session not found",
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

        // Fire on_close hook with timeout (fail-open). Precedence:
        // webhook > in-process handler.
        const manifest = this.manifests.get(sessionRow.app_id);
        const onCloseWebhook = manifest?.hooks?.on_close?.webhook;
        const appHooks = this.hooks.get(sessionRow.app_id);

        if (onCloseWebhook || appHooks?.onClose) {
          const timeoutMs = manifest?.hooks?.on_close?.timeout_ms ?? 5000;

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

          const outcome: HookOutcome<void> = onCloseWebhook
            ? yield* this.dispatchWebhookHook<void>({
                url: onCloseWebhook,
                event: "app.on_close",
                secret: manifest?.hooks?.secret,
                body: {
                  sessionId,
                  appId: sessionRow.app_id,
                  conversations,
                  closedBy,
                },
                timeoutMs,
              })
            : yield* this.runHookWithTimeout<void>(
                (signal) =>
                  appHooks!.onClose!({
                    sessionId,
                    appId: sessionRow.app_id,
                    conversations,
                    closedBy,
                    signal,
                  }),
                timeoutMs,
              );

          if (outcome.timedOut) {
            this.broadcaster.sendToAgent(
              callerAgentId,
              eventFrame("app/hookTimeout", {
                sessionId,
                appId: sessionRow.app_id,
                hookName: "on_close",
                timeoutMs,
              }),
            );
            yield* Effect.logWarning("on_close hook timed out").pipe(
              Effect.annotateLogs({
                sessionId,
                appId: sessionRow.app_id,
                timeoutMs,
              }),
            );
          }
        }

        const convIdArray = [...convIds];
        if (convIdArray.length > 0) {
          yield* this.db
            .updateTable("conversations")
            .set({ archived_at: new Date() })
            .where("id", "in", convIdArray);
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

        const closedEvent = eventFrame("app/sessionClosed", {
          sessionId,
          closedBy: callerAgentId,
        });
        this.broadcaster.sendToAgent(callerAgentId, closedEvent);
        for (const agentId of participantAgentIds) {
          this.broadcaster.sendToAgent(agentId, closedEvent);
        }

        return { closed: true };
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
              message: "Session not found",
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
          id: sessionRow.id,
          appId: sessionRow.app_id,
          initiatorAgentId: sessionRow.initiator_agent_id,
          status: sessionRow.status,
          conversations,
          createdAt: new Date(
            sessionRow.created_at as unknown as string,
          ).toISOString(),
        };
        if (sessionRow.closed_at) {
          session.closedAt = new Date(
            sessionRow.closed_at as unknown as string,
          ).toISOString();
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

        const limit = opts?.limit ?? 50;
        query = query.limit(limit);

        const rows = yield* query;

        return rows.map((row) => {
          const session: AppSession = {
            id: row.id,
            appId: row.app_id,
            initiatorAgentId: row.initiator_agent_id,
            status: row.status,
            conversations: {},
            createdAt: new Date(
              row.created_at as unknown as string,
            ).toISOString(),
          };
          if (row.closed_at) {
            session.closedAt = new Date(
              row.closed_at as unknown as string,
            ).toISOString();
          }
          return session;
        });
      }),
    );
  }

  /** Clear pending challenge state. Called on shutdown. */
  destroy(): void {
    // Pending challenges are guarded by an outer Effect.timeoutFail in
    // checkCapability; their awaiting fibers are interrupted via the
    // session teardown path. Clearing the Map is enough.
    this.pendingChallenges.clear();
    Effect.runSync(drainCoalesceMap(this.inflightPermissions));
    this.hooks.clear();
    this.conversationToSession.clear();
    this.sessionToConversations.clear();
  }

  listGrants(
    userId: string,
    appId?: string,
  ): Effect.Effect<
    Array<{
      appId: string;
      resource: string;
      access: string[];
      grantedAt: string;
    }>,
    RpcFailure
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        let query = this.db
          .selectFrom("app_permission_grants")
          .select(["app_id", "resource", "access", "granted_at"])
          .where("user_id", "=", userId);

        if (appId) {
          query = query.where("app_id", "=", appId);
        }

        const rows = yield* query;
        return rows.map((r) => ({
          appId: r.app_id,
          resource: r.resource,
          access: r.access,
          grantedAt: new Date(r.granted_at).toISOString(),
        }));
      }),
    );
  }

  revokeGrant(
    userId: string,
    appId: string,
    resource: string,
  ): Effect.Effect<void, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* this.db
          .deleteFrom("app_permission_grants")
          .where("user_id", "=", userId)
          .where("app_id", "=", appId)
          .where("resource", "=", resource);
      }),
    );
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

  private runHookWithTimeout<T>(
    fn: (signal: AbortSignal) => T | Promise<T>,
    timeoutMs: number,
  ): Effect.Effect<HookOutcome<T>, RpcFailure> {
    // AbortController contract is part of the user-provided hook signature, so
    // we keep allocating one and wire it to interruption: if Effect.timeout
    // fires or the hook throws, abort() before returning. The hook itself runs
    // inside Effect.tryPromise and is bounded by Effect.timeout — no raw
    // Promise.race / setTimeout.
    return Effect.gen(this, function* () {
      const controller = new AbortController();
      const hookEffect = Effect.tryPromise({
        try: () => Promise.resolve(fn(controller.signal)),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return yield* hookEffect.pipe(
        Effect.timeout(`${timeoutMs} millis`),
        Effect.map((result) => ({ result, timedOut: false }) as HookOutcome<T>),
        Effect.catchTag("TimeoutException", () =>
          Effect.sync(() => {
            controller.abort();
            return { result: null, timedOut: true as const } as HookOutcome<T>;
          }),
        ),
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            controller.abort();
            yield* Effect.logError("Hook execution error").pipe(
              Effect.annotateLogs({ err: errorMessage(err) }),
            );
            return {
              result: null,
              timedOut: false as const,
            } as HookOutcome<T>;
          }),
        ),
      );
    });
  }

  /**
   * Dispatch a hook by POSTing its payload to an HTTPS webhook URL.
   *
   * - Serializes `body` to JSON.
   * - If a `secret` is provided, signs the JSON with HMAC-SHA256 and sets
   *   `X-MoltZap-Signature: sha256=<hex>`. The signature covers exactly the
   *   bytes that go on the wire — we pre-serialize and hand the client
   *   `bodyJson` so it can't rewrite whitespace or reorder keys.
   * - Enforces the hook's `timeoutMs` via `Effect.timeout`. Webhook
   *   transport errors (non-2xx, network drop) bubble out of
   *   `WebhookClient.callSync` as `WebhookError` and land in the
   *   `catchAll` branch — which matches the in-process
   *   `runHookWithTimeout` semantics so the caller's fail-closed plumbing
   *   stays identical regardless of dispatch mechanism.
   */
  private dispatchWebhookHook<T>(opts: {
    url: string;
    event: string;
    body: object;
    timeoutMs: number;
    secret?: string;
  }): Effect.Effect<HookOutcome<T>, RpcFailure> {
    return Effect.gen(this, function* () {
      const bodyJson = JSON.stringify(opts.body);
      const signature = opts.secret
        ? `sha256=${createHmac("sha256", opts.secret).update(bodyJson).digest("hex")}`
        : undefined;

      const request = Effect.tryPromise({
        try: () =>
          this.webhookClient.callSync<T>({
            url: opts.url,
            event: opts.event,
            body: undefined,
            bodyJson,
            headers: signature
              ? { "X-MoltZap-Signature": signature }
              : undefined,
            timeoutMs: opts.timeoutMs,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return yield* request.pipe(
        Effect.timeout(`${opts.timeoutMs} millis`),
        Effect.map((result) => ({ result, timedOut: false }) as HookOutcome<T>),
        Effect.catchTag("TimeoutException", () =>
          Effect.succeed({
            result: null,
            timedOut: true as const,
          } as HookOutcome<T>),
        ),
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            // WebhookClient surfaces its own timeout as a WebhookError
            // with "timed out" in the message (HTTP-level
            // AbortSignal.timeout fires before Effect.timeout when
            // timeoutMs is short). Normalise both paths to
            // timedOut:true so the caller's hookTimeout event fires
            // consistently.
            const msg = errorMessage(err);
            if (/timed out/i.test(msg)) {
              return {
                result: null,
                timedOut: true as const,
              } as HookOutcome<T>;
            }
            yield* Effect.logError("Webhook hook dispatch error").pipe(
              Effect.annotateLogs({
                err: msg,
                url: opts.url,
                event: opts.event,
              }),
            );
            return {
              result: null,
              timedOut: false as const,
            } as HookOutcome<T>;
          }),
        ),
      );
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
      // calls. Uses the same `coalesce` helper as `inflightPermissions` so
      // concurrent admitAgent fibers for the same owner race-safely share
      // one in-flight validateUser call (see runtime/coalesce.ts).
      const userValidationCache = Effect.runSync(
        Ref.make(
          HashMap.empty<string, Deferred.Deferred<{ valid: boolean }, never>>(),
        ),
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
                return "rejected" as const;
              },
              onSuccess: () => "admitted" as const,
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );

      const allRejected = outcomes.every((s) => s === "rejected");
      const finalStatus = allRejected ? "failed" : "active";

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
          eventFrame("app/sessionFailed", {
            sessionId: session.id,
          }),
        );
        yield* Effect.logWarning("All agents rejected — session failed").pipe(
          Effect.annotateLogs({ sessionId: session.id }),
        );
      } else {
        this.broadcaster.sendToAgent(
          initiatorAgentId,
          eventFrame("app/sessionReady", {
            sessionId: session.id,
            conversations: session.conversations,
          }),
        );
      }
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
        yield* this.rejectAgent(
          session.id,
          agentId,
          "identity",
          "Agent not found",
          undefined,
          "AgentNotFound",
        );
        return yield* Effect.fail(
          new RpcFailure({
            code: ErrorCodes.AgentNotFound,
            message: "Agent not found",
          }),
        );
      }

      // User, identity, and capability checks are independent — run concurrently.
      // Track whether we've already rejected this agent so concurrent failures
      // don't send duplicate rejection events.
      let rejected = false;
      const guardedReject = (
        ...args: Parameters<typeof this.rejectAgent>
      ): Effect.Effect<void, RpcFailure> => {
        if (rejected) return Effect.void;
        rejected = true;
        return this.rejectAgent(...args);
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

      if (manifest.skillUrl) {
        checks.push(
          this.checkCapability(session, agentId, manifest, guardedReject),
        );
      }

      // User validation (coalesced per ownerUserId). Two concurrent
      // admitAgent fibers for agents owned by the same user share a
      // single in-flight validateUser call via `coalesce`; the Map-based
      // has/set pattern we used previously had a race where both fibers
      // could create separate Deferreds and fire redundant webhooks.
      if (this.userService && agent.owner_user_id) {
        const userId = agent.owner_user_id;
        const userService = this.userService;
        checks.push(
          Effect.gen(this, function* () {
            const { valid } = yield* coalesce(
              userValidationCache,
              userId,
              userService.validateUser(userId),
            );
            if (!valid) {
              yield* guardedReject(
                session.id,
                agentId,
                "user",
                "User validation failed",
                undefined,
                "UserInvalid",
              );
              return yield* Effect.fail(forbidden("User validation failed"));
            }
          }),
        );
      }

      const results = yield* Effect.all(checks, {
        concurrency: "unbounded",
        mode: "either",
      });

      for (const result of results) {
        if (result._tag === "Left") {
          return yield* Effect.fail(result.left);
        }
      }

      const grantedResources = yield* this.checkPermissions(
        session,
        agentId,
        manifest,
        agentMap,
      );

      yield* this.admitAgentToSession(
        session,
        agentId,
        grantedResources,
        agent.owner_user_id ?? "",
      );
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
    reject?: (
      ...args: Parameters<typeof this.rejectAgent>
    ) => Effect.Effect<void, RpcFailure>,
  ): Effect.Effect<void, RpcFailure> {
    return Effect.gen(this, function* () {
      const doReject =
        reject ??
        ((...args: Parameters<typeof this.rejectAgent>) =>
          this.rejectAgent(...args));

      const agent = agentMap.get(agentId)!;
      const initiator = agentMap.get(initiatorAgentId)!;

      if (!agent.owner_user_id) {
        yield* doReject(
          session.id,
          agentId,
          "identity",
          "Agent has no owner_user_id",
          "Set owner_user_id on the agent before inviting it to app sessions",
          "AgentNoOwner",
        );
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
        yield* doReject(
          session.id,
          agentId,
          "identity",
          "Agent owner is not a contact of the session initiator's owner",
          undefined,
          "NotInContacts",
        );
        return yield* Effect.fail(forbidden("Not in contacts"));
      }
    });
  }

  private checkCapability(
    session: AppSession,
    agentId: string,
    manifest: AppManifest,
    reject?: (
      ...args: Parameters<typeof this.rejectAgent>
    ) => Effect.Effect<void, RpcFailure>,
  ): Effect.Effect<void, RpcFailure> {
    return Effect.gen(this, function* () {
      const doReject =
        reject ??
        ((...args: Parameters<typeof this.rejectAgent>) =>
          this.rejectAgent(...args));

      const challengeId = crypto.randomUUID();
      const timeoutMs = manifest.challengeTimeoutMs ?? 30000;

      // Await external attestation only; the timeout is expressed as
      // Effect.timeoutFail below so it uses the Effect Clock (TestClock-
      // drivable) instead of raw setTimeout.
      const waitForAttestation = Effect.async<
        { skillUrl: string; version: string },
        SkillAttestationError
      >((resume) => {
        this.pendingChallenges.set(challengeId, {
          targetAgentId: agentId,
          sessionId: session.id,
          resolve: (result) => resume(Effect.succeed(result)),
          reject: (reason: string) =>
            resume(Effect.fail(new SkillAttestationError({ reason }))),
        });

        this.broadcaster.sendToAgent(
          agentId,
          eventFrame("app/skillChallenge", {
            challengeId,
            sessionId: session.id,
            appId: session.appId,
            skillUrl: manifest.skillUrl!,
            minVersion: manifest.skillMinVersion,
          }),
        );

        // Fiber interrupt cleanup (Effect.timeoutFail interrupts this
        // Effect when the outer timeout fires; session teardown does
        // too via the pending.reject path).
        return Effect.sync(() => {
          this.pendingChallenges.delete(challengeId);
        });
      });

      const attestation = yield* Effect.either(
        waitForAttestation.pipe(
          Effect.timeoutFail({
            duration: Duration.millis(timeoutMs),
            onTimeout: () => new AttestationTimeoutError({ challengeId }),
          }),
        ),
      );

      if (attestation._tag === "Left") {
        const err = attestation.left;
        const isTimeout = err._tag === "AttestationTimeout";
        const code = isTimeout ? "AttestationTimeout" : "SkillMismatch";
        const reason = isTimeout
          ? "Skill attestation timed out"
          : `Skill attestation failed: ${err.message}`;
        yield* doReject(
          session.id,
          agentId,
          "capability",
          reason,
          `Install the skill from ${manifest.skillUrl} and ensure version >= ${manifest.skillMinVersion ?? "any"}`,
          code,
        );
        return yield* Effect.fail(forbidden(reason));
      }

      const result = attestation.right;

      if (result.skillUrl !== manifest.skillUrl) {
        yield* doReject(
          session.id,
          agentId,
          "capability",
          `Skill URL mismatch: expected ${manifest.skillUrl}, got ${result.skillUrl}`,
          undefined,
          "SkillMismatch",
        );
        return yield* Effect.fail(forbidden("Skill mismatch"));
      }

      if (
        manifest.skillMinVersion &&
        compareSemver(result.version, manifest.skillMinVersion) < 0
      ) {
        yield* doReject(
          session.id,
          agentId,
          "capability",
          `Skill version ${result.version} below minimum ${manifest.skillMinVersion}`,
          undefined,
          "SkillVersionTooOld",
        );
        return yield* Effect.fail(forbidden("Skill version too low"));
      }
    });
  }

  private findGrant(
    userId: string,
    appId: string,
    resource: string,
    requiredAccess: string[],
  ): Effect.Effect<{ access: string[] } | undefined, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("app_permission_grants")
            .select("access")
            .where("user_id", "=", userId)
            .where("app_id", "=", appId)
            .where("resource", "=", resource),
        );

        if (Option.isNone(rowOpt)) return undefined;
        const row = rowOpt.value;
        // Set-containment: stored access must cover ALL required access
        const stored = new Set(row.access);
        const covers = requiredAccess.every((a) => stored.has(a));
        return covers ? row : undefined;
      }),
    );
  }

  private checkPermissions(
    session: AppSession,
    agentId: string,
    manifest: AppManifest,
    agentMap: Map<
      string,
      { id: string; owner_user_id: string | null; status: string }
    >,
  ): Effect.Effect<string[], RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const agent = agentMap.get(agentId)!;
        const ownerUserId = agent.owner_user_id!;
        const granted: string[] = [];

        const allResources = [
          ...manifest.permissions.required,
          ...manifest.permissions.optional,
        ].map((p) => p.resource);
        const existingGrants = new Map<string, string[]>();
        if (allResources.length > 0) {
          const rows = yield* this.db
            .selectFrom("app_permission_grants")
            .select(["resource", "access"])
            .where("user_id", "=", ownerUserId)
            .where("app_id", "=", session.appId)
            .where("resource", "in", allResources);
          for (const row of rows) {
            existingGrants.set(row.resource, row.access);
          }
        }

        for (const perm of manifest.permissions.required) {
          const storedAccess = existingGrants.get(perm.resource);
          const storedSet = storedAccess ? new Set(storedAccess) : null;
          const covers =
            storedSet && perm.access.every((a) => storedSet.has(a));

          if (covers) {
            granted.push(perm.resource);
            continue;
          }

          if (!this.permissionService) {
            yield* this.rejectAgent(
              session.id,
              agentId,
              "permission",
              `No permission handler configured for resource: ${perm.resource}`,
              "Server must configure a PermissionService to process permission requests",
              "NoPermissionHandler",
            );
            return yield* Effect.fail(forbidden("No permission handler"));
          }

          // Coalescing: same userId+appId+resource reuses in-flight request.
          // Race-safe via `coalesce`'s atomic Ref.modify test-and-insert.
          const coalesceKey = `${ownerUserId}:${session.appId}:${perm.resource}`;
          yield* Effect.logInfo("Requesting permission from handler").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              appId: session.appId,
              resource: perm.resource,
              agentId,
            }),
          );

          const exit = yield* Effect.exit(
            coalesce(
              this.inflightPermissions,
              coalesceKey,
              this.permissionService.requestPermission({
                userId: ownerUserId,
                agentId,
                sessionId: session.id,
                appId: session.appId,
                resource: perm.resource,
                access: perm.access,
                timeoutMs: manifest.permissionTimeoutMs ?? 120000,
              }),
            ),
          );

          if (Exit.isFailure(exit)) {
            const failure = Cause.failureOption(exit.cause);
            const err = failure._tag === "Some" ? failure.value : null;

            if (
              err instanceof PermissionDeniedError ||
              err instanceof PermissionTimeoutError
            ) {
              const code =
                err instanceof PermissionTimeoutError
                  ? "PermissionTimeout"
                  : "PermissionDenied";
              yield* Effect.logWarning("Permission request failed").pipe(
                Effect.annotateLogs({
                  err: err.message,
                  sessionId: session.id,
                  resource: perm.resource,
                }),
              );
              yield* this.rejectAgent(
                session.id,
                agentId,
                "permission",
                err.message,
                `Grant ${perm.resource} access via the permission prompt`,
                code,
              );
              return yield* Effect.fail(forbidden(err.message));
            }

            // Unknown failure or defect
            yield* Effect.logError("Permission handler error").pipe(
              Effect.annotateLogs({
                cause: Cause.pretty(exit.cause),
                sessionId: session.id,
                resource: perm.resource,
              }),
            );
            yield* this.rejectAgent(
              session.id,
              agentId,
              "permission",
              `Permission handler error for resource: ${perm.resource}`,
              `Grant ${perm.resource} access via the permission prompt`,
              "PermissionHandlerError",
            );
            return yield* Effect.fail(
              forbidden(`Permission denied for resource: ${perm.resource}`),
            );
          }

          const access = exit.value;

          yield* Effect.logInfo("Permission handler responded").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              resource: perm.resource,
              access,
            }),
          );

          // Post-handler validation: returned access must cover required access
          const returnedSet = new Set(access);
          const accessCovers = perm.access.every((a) => returnedSet.has(a));
          if (!accessCovers) {
            yield* Effect.logWarning("Permission request failed").pipe(
              Effect.annotateLogs({
                sessionId: session.id,
                resource: perm.resource,
              }),
            );
            yield* this.rejectAgent(
              session.id,
              agentId,
              "permission",
              `Permission denied for resource: ${perm.resource}`,
              `Grant ${perm.resource} access via the permission prompt`,
              "PermissionDenied",
            );
            return yield* Effect.fail(
              forbidden(`Permission denied for resource: ${perm.resource}`),
            );
          }

          // Store the grant
          yield* this.db
            .insertInto("app_permission_grants")
            .values({
              user_id: ownerUserId,
              app_id: session.appId,
              resource: perm.resource,
              access,
            })
            .onConflict((oc) =>
              oc
                .columns(["user_id", "app_id", "resource"])
                .doUpdateSet({ access }),
            );

          granted.push(perm.resource);
        }

        for (const perm of manifest.permissions.optional) {
          const storedAccess = existingGrants.get(perm.resource);
          const covers =
            storedAccess &&
            perm.access.every((a) => new Set(storedAccess).has(a));
          if (covers) {
            granted.push(perm.resource);
          }
        }

        return granted;
      }),
    );
  }

  private admitAgentToSession(
    session: AppSession,
    agentId: string,
    grantedResources: string[],
    ownerId: string,
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

        const admittedEvent = eventFrame("app/participantAdmitted", {
          sessionId: session.id,
          agentId,
          grantedResources,
        });
        this.broadcaster.sendToAgent(agentId, admittedEvent);
        this.broadcaster.sendToAgent(session.initiatorAgentId, admittedEvent);

        yield* Effect.logInfo("Agent admitted to app session").pipe(
          Effect.annotateLogs({
            sessionId: session.id,
            agentId,
            grantedResources,
          }),
        );

        // on_join hook dispatch. Precedence: webhook > in-process handler.
        // Both paths are fire-and-forget (the hook can't block admission);
        // errors are logged but do not fail the fiber.
        const webhookUrl = manifest.hooks?.on_join?.webhook;
        const appHooks = this.hooks.get(session.appId);

        if (webhookUrl) {
          const timeoutMs = manifest.hooks?.on_join?.timeout_ms ?? 5000;
          const outcome = yield* this.dispatchWebhookHook<void>({
            url: webhookUrl,
            event: "app.on_join",
            secret: manifest.hooks?.secret,
            body: {
              sessionId: session.id,
              appId: session.appId,
              conversations: session.conversations,
              agent: { agentId, ownerId },
            },
            timeoutMs,
          });
          if (outcome.timedOut) {
            this.broadcaster.sendToAgent(
              agentId,
              eventFrame("app/hookTimeout", {
                sessionId: session.id,
                appId: session.appId,
                hookName: "on_join",
                timeoutMs,
              }),
            );
            yield* Effect.logWarning("on_join hook timed out").pipe(
              Effect.annotateLogs({
                sessionId: session.id,
                appId: session.appId,
                timeoutMs,
              }),
            );
          }
        } else if (appHooks?.onJoin) {
          // `tryPromise` catches both synchronous throws inside the hook
          // and Promise rejections, keeping the failure in the typed
          // error channel rather than becoming a defect.
          yield* Effect.tryPromise({
            try: () =>
              Promise.resolve(
                appHooks.onJoin!({
                  conversations: session.conversations,
                  agent: { agentId, ownerId },
                  sessionId: session.id,
                  appId: session.appId,
                }),
              ),
            catch: (err) => err,
          }).pipe(
            Effect.catchAll((err) =>
              Effect.logError("on_join hook error").pipe(
                Effect.annotateLogs({
                  err: errorMessage(err),
                  sessionId: session.id,
                  agentId,
                }),
              ),
            ),
          );
        }
      }),
    );
  }

  private rejectAgent(
    sessionId: string,
    agentId: string,
    stage: "user" | "identity" | "capability" | "permission",
    reason: string,
    suggestedAction: string | undefined,
    rejectionCode:
      | "UserInvalid"
      | "UserValidationFailed"
      | "AgentNotFound"
      | "AgentNoOwner"
      | "NotInContacts"
      | "ContactCheckFailed"
      | "AttestationTimeout"
      | "SkillMismatch"
      | "SkillVersionTooOld"
      | "PermissionDenied"
      | "PermissionTimeout"
      | "PermissionHandlerError"
      | "NoPermissionHandler",
  ): Effect.Effect<void, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* this.db
          .updateTable("app_session_participants")
          .set({ status: "rejected", rejection_reason: reason })
          .where("session_id", "=", sessionId)
          .where("agent_id", "=", agentId);

        this.broadcaster.sendToAgent(
          agentId,
          eventFrame("app/participantRejected", {
            sessionId,
            agentId,
            reason,
            stage,
            suggestedAction,
            rejectionCode,
          }),
        );

        yield* Effect.logInfo("Agent rejected from app session").pipe(
          Effect.annotateLogs({
            sessionId,
            agentId,
            stage,
            reason,
            rejectionCode,
          }),
        );
      }),
    );
  }
}
