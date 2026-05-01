import type { Kysely } from "kysely";
import type { AppSessionStatus, Database } from "../db/database.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager, MoltZapConnection } from "../ws/connection.js";
import { sendRpcToClient } from "../ws/connection.js";
import type { UserService } from "../services/user.service.js";
import { UserId } from "./types.js";
import { logger } from "../logger.js";
import type {
  AppManifest,
  AppSession,
  LogicalClock,
  Part,
} from "@moltzap/protocol";
import {
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnClose,
  AppsOnJoin,
  AppsOnSessionActive,
  ErrorCodes,
  EventNames,
  eventFrame,
} from "@moltzap/protocol";
import {
  decodeBeforeDispatchRpcResult,
  decodeBeforeMessageDeliveryRpcResult,
  decodeVoidRpcResult,
  type AppHooks,
  type BeforeDispatchContext,
  type BeforeDispatchHook,
  type BeforeMessageDeliveryContext,
  type BeforeMessageDeliveryHook,
  type DispatchAdmissionResult,
  type HookResult,
  type OnCloseContext,
  type OnCloseHook,
  type OnJoinContext,
  type OnJoinHook,
  type OnSessionActiveContext,
  type OnSessionActiveHook,
} from "./hooks.js";
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

/**
 * True iff `stored` contains every access string in `required`. Missing or
 * empty `stored` always fails. Used both for existing-grant coverage checks
 * and post-handler validation of a fresh permission response.
 */
function grantsAllRequiredAccess(
  stored: readonly string[] | null | undefined,
  required: readonly string[],
): boolean {
  if (!stored) return false;
  const storedSet = new Set(stored);
  return required.every((a) => storedSet.has(a));
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
  override get message(): string {
    return `Permission denied for resource: ${this.resource}`;
  }
}

export class PermissionTimeoutError extends Data.TaggedError(
  "PermissionTimeout",
)<{
  readonly resource: string;
}> {
  override get message(): string {
    return `Permission timeout for resource: ${this.resource}`;
  }
}

class AttestationTimeoutError extends Data.TaggedError("AttestationTimeout")<{
  readonly challengeId: string;
}> {
  override get message(): string {
    return "attestation timeout";
  }
}

class SkillAttestationError extends Data.TaggedError("SkillAttestation")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

type RejectionStage = "user" | "identity" | "capability" | "permission";
type RejectionCode =
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
  | "NoPermissionHandler";

interface RejectionInfo {
  readonly stage: RejectionStage;
  readonly reason: string;
  readonly code: RejectionCode;
  readonly suggestedAction?: string;
}

interface PendingChallenge {
  targetAgentId: string;
  sessionId: string;
  resolve: (result: { skillUrl: string; version: string }) => void;
  reject: (reason: string) => void;
}

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
    /**
     * Coalesce map for in-flight permission requests. Constructed in the
     * AppHost Layer so `Ref.make` runs inside an Effect rather than via
     * `Effect.runSync` at field-initializer time.
     */
    private inflightPermissions: Ref.Ref<
      HashMap.HashMap<string, Deferred.Deferred<string[], Error>>
    >,
  ) {}

  registerApp(manifest: AppManifest): void {
    this.manifests.set(manifest.appId, manifest);
    logger.info({ appId: manifest.appId }, "App registered");
  }

  /**
   * Register an app whose hook handlers run in a remote process (typically
   * an `@moltzap/app-sdk` client connected over WebSocket). Hook RPCs
   * (`apps/onBeforeDispatch`, `onBeforeMessageDelivery`, `onSessionActive`,
   * `onJoin`, `onClose`) are dispatched to `connectionId` via
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
   * pending Deferred for that connection's s2c RPCs fails with
   * `AppDisconnected` via the connection's Scope finalizer. The dispatch
   * envelope catches `AppDisconnected` (and every other `S2cRpcError`
   * variant) and synthesizes a fail-closed verdict — `deny` for
   * admission hooks, `block: true` for `before_message_delivery`, void +
   * log + `app/hookTimeout` for lifecycle hooks. Callers do not need to
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

  getManifest(appId: string): AppManifest | undefined {
    return this.manifests.get(appId);
  }

  isAttachedToActiveSession(conversationId: string): boolean {
    return this.conversationToSession.has(conversationId);
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
  }

  onBeforeDispatch(appId: string, handler: BeforeDispatchHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.beforeDispatch = handler;
    this.hooks.set(appId, existing);
  }

  onAppJoin(appId: string, handler: OnJoinHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.onJoin = handler;
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
            UserId(initiator.owner_user_id),
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
          yield* this.dispatchOnCloseHook(
            sessionRow.app_id,
            ctx,
            callerAgentId,
          );
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
            eventFrame(EventNames.ConversationArchived, {
              conversationId: convId,
              archivedAt: archivedAt.toISOString(),
              by: callerAgentId,
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
              message: "Session not found",
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

  /** Clear pending challenge state. Called on shutdown. */
  destroy(): void {
    // Pending challenges are guarded by an outer Effect.timeoutFail in
    // checkCapability; their awaiting fibers are interrupted via the
    // session teardown path. Clearing the Map is enough.
    this.pendingChallenges.clear();
    Effect.runSync(drainCoalesceMap(this.inflightPermissions));
    this.hooks.clear();
    this.remoteRegistrations.clear();
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

  // ── Uniform hook dispatch (in-process + remote) ────────────────────
  //
  // Per architect plan §3.4: every hook returns `Effect<Verdict, never>`
  // regardless of source. The branching between in-process and remote is
  // INSIDE the dispatch helpers; call sites observe one type. Failure
  // modes (timeout, throw, RPC error, AppDisconnected, decode failure)
  // collapse into fail-closed verdicts for admission hooks (`deny` /
  // `block`), or void + `app/hookTimeout` event for lifecycle hooks.
  //
  // Multi-app composition (architect plan §3.4: "Effect.forEach in
  // registration order, first deny short-circuits") is implemented by
  // {@link dispatchAcrossAppsWithDenyShortCircuit} below. Today every
  // session is bound to a single appId so the iteration is len-1; the
  // combinator is forward-compatible for multi-app sessions.

  /**
   * Strip non-wire-safe fields from a hook context so it can be sent over
   * the s2c RPC. Currently the only such field is `signal: AbortSignal`,
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
   * Result decoding happens at this seam — Principle 2: schemas at
   * boundaries, types inside. After decode the rest of AppHost trusts
   * the verdict shape.
   */
  private runRemoteHookEffect<T>(opts: {
    appId: string;
    method: string;
    connectionId: string;
    params: unknown;
    /**
     * Precompiled decoder (`Schema.decodeUnknown(schema)`) lifted to a
     * module-level constant in `hooks.ts`. Passing the decoder rather
     * than the schema avoids rebuilding the closure on every dispatch
     * — `messages/send` triggers `runBeforeDispatch` per recipient, so
     * this is the per-message hot path.
     */
    decode: (raw: unknown) => Effect.Effect<T, unknown, never>;
  }): Effect.Effect<T, Error> {
    return Effect.gen(this, function* () {
      const conn: MoltZapConnection | undefined = this.connections.get(
        opts.connectionId,
      );
      if (!conn) {
        // Stale registration: the remote app's connection has already
        // gone away. Treat identically to mid-flight `AppDisconnected`
        // so the dispatch envelope folds it into fail-closed.
        return yield* Effect.fail(
          new Error(
            `Remote app ${opts.appId} connection ${opts.connectionId} is gone`,
          ),
        );
      }
      const raw = yield* sendRpcToClient(conn, opts.method, opts.params).pipe(
        Effect.mapError((err) => new Error(`s2c RPC failed: ${err._tag}`)),
      );
      return yield* opts
        .decode(raw)
        .pipe(
          Effect.mapError(
            (err) =>
              new Error(
                `s2c RPC ${opts.method} response decode failed: ${String(err)}`,
              ),
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
   *   - `TimeoutException` (from `Effect.timeout`) → emits the
   *     `app/hookTimeout` event, logs a warning, returns the timeout
   *     verdict from `onTimeout`.
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
    onTimeoutEvent?: () => void; // emit `app/hookTimeout` if provided
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
          if (opts.onTimeoutEvent) opts.onTimeoutEvent();
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
    const timeoutMs = manifest?.hooks?.before_dispatch?.timeout_ms ?? 5000;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<DispatchAdmissionResult, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          method: AppsOnBeforeDispatch.name,
          connectionId: remote.connectionId,
          params: this.contextForWire(ctx),
          decode: decodeBeforeDispatchRpcResult,
        }).pipe(Effect.map((envelope) => envelope.admission))
      : this.runInProcessHookEffect<
          BeforeDispatchContext,
          DispatchAdmissionResult
        >((ctxWithSignal) => inProcess!(ctxWithSignal), ctx);

    return this.wrapHookEffectWithEnvelope<DispatchAdmissionResult>({
      raw,
      timeoutMs,
      onTimeoutEvent: () =>
        this.broadcaster.sendToAgent(
          ctx.recipient.agentId,
          eventFrame(EventNames.AppHookTimeout, {
            sessionId,
            appId,
            hookName: "before_dispatch",
            timeoutMs,
          }),
        ),
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
      manifest?.hooks?.before_message_delivery?.timeout_ms ?? 5000;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<HookResult, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          method: AppsOnBeforeMessageDelivery.name,
          connectionId: remote.connectionId,
          params: this.contextForWire(ctx),
          decode: decodeBeforeMessageDeliveryRpcResult,
        })
      : this.runInProcessHookEffect<BeforeMessageDeliveryContext, HookResult>(
          (ctxWithSignal) => inProcess!(ctxWithSignal),
          ctx,
        );

    return this.wrapHookEffectWithEnvelope<HookResult>({
      raw,
      timeoutMs,
      onTimeoutEvent: () =>
        this.broadcaster.sendToAgent(
          ctx.sender.agentId,
          eventFrame(EventNames.AppHookTimeout, {
            sessionId,
            appId,
            hookName: "before_message_delivery",
            timeoutMs,
          }),
        ),
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
   * Fail-OPEN: timeout/throw logs + emits `app/hookTimeout` but the caller
   * continues to broadcast `app/sessionReady` (the ordering invariant
   * verified by `31-on-session-active.integration.test.ts:200-230`).
   */
  private dispatchOnSessionActiveHook(
    appId: string,
    ctx: OnSessionActiveContext,
    initiatorAgentId: string,
  ): Effect.Effect<void, never> {
    const remote = this.remoteRegistrations.get(appId);
    const inProcess = this.hooks.get(appId)?.onSessionActive;
    if (!remote && !inProcess) return Effect.void;
    const manifest = this.manifests.get(appId);
    const timeoutMs = manifest?.hooks?.on_session_active?.timeout_ms ?? 5000;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<void, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          method: AppsOnSessionActive.name,
          connectionId: remote.connectionId,
          params: this.contextForWire(ctx),
          decode: decodeVoidRpcResult,
        })
      : this.runInProcessHookEffect<OnSessionActiveContext, void>(
          (ctxWithSignal) => inProcess!(ctxWithSignal),
          ctx,
        );

    return this.wrapHookEffectWithEnvelope<void>({
      raw,
      timeoutMs,
      onTimeoutEvent: () =>
        this.broadcaster.sendToAgent(
          initiatorAgentId,
          eventFrame(EventNames.AppHookTimeout, {
            sessionId,
            appId,
            hookName: "on_session_active",
            timeoutMs,
          }),
        ),
      timeoutLogMessage: "on_session_active hook timed out",
      timeoutLogContext: { sessionId, appId, timeoutMs },
      errorLogMessage: "on_session_active hook error",
      errorLogContext: { sessionId, appId },
      onTimeout: () => undefined,
      onError: () => undefined,
    });
  }

  /**
   * Uniform `on_join` dispatch — awaitable void with timeout. Fail-OPEN
   * per architect plan §3.4.
   */
  private dispatchOnJoinHook(
    appId: string,
    ctx: OnJoinContext,
  ): Effect.Effect<void, never> {
    const remote = this.remoteRegistrations.get(appId);
    const inProcess = this.hooks.get(appId)?.onJoin;
    if (!remote && !inProcess) return Effect.void;
    const manifest = this.manifests.get(appId);
    const timeoutMs = manifest?.hooks?.on_join?.timeout_ms ?? 5000;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<void, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          method: AppsOnJoin.name,
          connectionId: remote.connectionId,
          params: ctx, // no signal field on OnJoinContext
          decode: decodeVoidRpcResult,
        })
      : Effect.tryPromise({
          try: () => Promise.resolve(inProcess!(ctx)),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        });

    return this.wrapHookEffectWithEnvelope<void>({
      raw,
      timeoutMs,
      onTimeoutEvent: () =>
        this.broadcaster.sendToAgent(
          ctx.agent.agentId,
          eventFrame(EventNames.AppHookTimeout, {
            sessionId,
            appId,
            hookName: "on_join",
            timeoutMs,
          }),
        ),
      timeoutLogMessage: "on_join hook timed out",
      timeoutLogContext: { sessionId, appId, timeoutMs },
      errorLogMessage: "on_join hook error",
      errorLogContext: { sessionId, appId, agentId: ctx.agent.agentId },
      onTimeout: () => undefined,
      onError: () => undefined,
    });
  }

  /**
   * Uniform `on_close` dispatch — awaitable void with timeout. Fail-OPEN
   * per architect plan §3.4. Target of `app/hookTimeout` event is the
   * caller (closer) since the session is being torn down.
   */
  private dispatchOnCloseHook(
    appId: string,
    ctx: OnCloseContext,
    callerAgentId: string,
  ): Effect.Effect<void, never> {
    const remote = this.remoteRegistrations.get(appId);
    const inProcess = this.hooks.get(appId)?.onClose;
    if (!remote && !inProcess) return Effect.void;
    const manifest = this.manifests.get(appId);
    const timeoutMs = manifest?.hooks?.on_close?.timeout_ms ?? 5000;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<void, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          method: AppsOnClose.name,
          connectionId: remote.connectionId,
          params: this.contextForWire(ctx),
          decode: decodeVoidRpcResult,
        })
      : this.runInProcessHookEffect<OnCloseContext, void>(
          (ctxWithSignal) => inProcess!(ctxWithSignal),
          ctx,
        );

    return this.wrapHookEffectWithEnvelope<void>({
      raw,
      timeoutMs,
      onTimeoutEvent: () =>
        this.broadcaster.sendToAgent(
          callerAgentId,
          eventFrame(EventNames.AppHookTimeout, {
            sessionId,
            appId,
            hookName: "on_close",
            timeoutMs,
          }),
        ),
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
      // calls. Uses the same `coalesce` helper as `inflightPermissions` so
      // concurrent admitAgent fibers for the same owner race-safely share
      // one in-flight validateUser call (see runtime/coalesce.ts).
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
        { concurrency: "unbounded" },
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
          eventFrame("app/sessionFailed", {
            sessionId: session.id,
          }),
        );
        yield* Effect.logWarning("All agents rejected — session failed").pipe(
          Effect.annotateLogs({ sessionId: session.id }),
        );
      } else {
        // on_session_active fires once per session, after the status row is
        // active but BEFORE app/sessionReady is broadcast. Fail-open matches
        // on_join/on_close: timeout or handler throw logs + emits
        // app/hookTimeout, but admission still completes and sessionReady
        // still fires.
        yield* this.runOnSessionActive(
          session,
          manifest,
          initiatorAgentId,
          admittedAgentIds,
        );

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

  private runOnSessionActive(
    session: AppSession,
    manifest: AppManifest,
    initiatorAgentId: string,
    admittedAgentIds: string[],
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      // Uniform Effect dispatch — in-process / remote choice INSIDE the
      // helper. Fail-OPEN: any timeout or error logs + emits hookTimeout
      // but the caller still proceeds to broadcast `app/sessionReady`,
      // preserving the ordering invariant covered by
      // 31-on-session-active.integration.test.ts:200-230.
      const ctx: OnSessionActiveContext = {
        sessionId: session.id,
        appId: session.appId,
        conversations: session.conversations,
        admittedAgentIds,
        signal: new AbortController().signal,
      };
      yield* this.dispatchOnSessionActiveHook(
        session.appId,
        ctx,
        initiatorAgentId,
      );
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

      // User, identity, and capability checks are independent — run concurrently.
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

  private checkCapability(
    session: AppSession,
    agentId: string,
    manifest: AppManifest,
    reject?: (info: RejectionInfo) => Effect.Effect<void, RpcFailure>,
  ): Effect.Effect<void, RpcFailure> {
    return Effect.gen(this, function* () {
      const doReject =
        reject ??
        ((info: RejectionInfo) => this.rejectAgent(session.id, agentId, info));

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
        const code: RejectionCode = isTimeout
          ? "AttestationTimeout"
          : "SkillMismatch";
        const reason = isTimeout
          ? "Skill attestation timed out"
          : `Skill attestation failed: ${err.message}`;
        yield* doReject({
          stage: "capability",
          reason,
          suggestedAction: `Install the skill from ${manifest.skillUrl} and ensure version >= ${manifest.skillMinVersion ?? "any"}`,
          code,
        });
        return yield* Effect.fail(forbidden(reason));
      }

      const result = attestation.right;

      if (result.skillUrl !== manifest.skillUrl) {
        yield* doReject({
          stage: "capability",
          reason: `Skill URL mismatch: expected ${manifest.skillUrl}, got ${result.skillUrl}`,
          code: "SkillMismatch",
        });
        return yield* Effect.fail(forbidden("Skill mismatch"));
      }

      if (
        manifest.skillMinVersion &&
        compareSemver(result.version, manifest.skillMinVersion) < 0
      ) {
        yield* doReject({
          stage: "capability",
          reason: `Skill version ${result.version} below minimum ${manifest.skillMinVersion}`,
          code: "SkillVersionTooOld",
        });
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

        // Split required perms by whether the existing grant already
        // covers them. Covered perms skip the permission RPC entirely;
        // the rest run in parallel so admission isn't serialized on the
        // slowest permission handler.
        const needsRequest: typeof manifest.permissions.required = [];
        for (const perm of manifest.permissions.required) {
          if (
            grantsAllRequiredAccess(
              existingGrants.get(perm.resource),
              perm.access,
            )
          ) {
            granted.push(perm.resource);
          } else {
            needsRequest.push(perm);
          }
        }

        if (needsRequest.length > 0 && !this.permissionService) {
          const firstResource = needsRequest[0]!.resource;
          yield* this.rejectAgent(session.id, agentId, {
            stage: "permission",
            reason: `No permission handler configured for resource: ${firstResource}`,
            suggestedAction:
              "Server must configure a PermissionService to process permission requests",
            code: "NoPermissionHandler",
          });
          return yield* Effect.fail(forbidden("No permission handler"));
        }

        const permissionService = this.permissionService;
        const requested = yield* Effect.forEach(
          needsRequest,
          (perm) =>
            // Coalescing: same userId+appId+resource reuses in-flight request.
            // Race-safe via `coalesce`'s atomic Ref.modify test-and-insert.
            this.requestAndStorePermission(
              permissionService!,
              session,
              agentId,
              ownerUserId,
              perm,
              manifest.permissionTimeoutMs ?? 120000,
            ),
          { concurrency: "unbounded" },
        );
        for (const resource of requested) {
          granted.push(resource);
        }

        for (const perm of manifest.permissions.optional) {
          if (
            grantsAllRequiredAccess(
              existingGrants.get(perm.resource),
              perm.access,
            )
          ) {
            granted.push(perm.resource);
          }
        }

        return granted;
      }),
    );
  }

  /**
   * Issue a permission request for one resource, validate the response
   * covers the required access, and persist the grant. Emits rejection
   * and fails with `forbidden` on denial / timeout / handler error.
   * Coalesced per (userId, appId, resource) so concurrent admissions
   * for the same grant share one RPC.
   */
  private requestAndStorePermission(
    permissionService: PermissionService,
    session: AppSession,
    agentId: string,
    ownerUserId: string,
    perm: { resource: string; access: string[] },
    timeoutMs: number,
  ): Effect.Effect<string, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
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
            permissionService.requestPermission({
              userId: ownerUserId,
              agentId,
              sessionId: session.id,
              appId: session.appId,
              resource: perm.resource,
              access: perm.access,
              timeoutMs,
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
            const code: RejectionCode =
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
            yield* this.rejectAgent(session.id, agentId, {
              stage: "permission",
              reason: err.message,
              suggestedAction: `Grant ${perm.resource} access via the permission prompt`,
              code,
            });
            return yield* Effect.fail(forbidden(err.message));
          }

          yield* Effect.logError("Permission handler error").pipe(
            Effect.annotateLogs({
              cause: Cause.pretty(exit.cause),
              sessionId: session.id,
              resource: perm.resource,
            }),
          );
          yield* this.rejectAgent(session.id, agentId, {
            stage: "permission",
            reason: `Permission handler error for resource: ${perm.resource}`,
            suggestedAction: `Grant ${perm.resource} access via the permission prompt`,
            code: "PermissionHandlerError",
          });
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

        if (!grantsAllRequiredAccess(access, perm.access)) {
          yield* Effect.logWarning("Permission request failed").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              resource: perm.resource,
            }),
          );
          yield* this.rejectAgent(session.id, agentId, {
            stage: "permission",
            reason: `Permission denied for resource: ${perm.resource}`,
            suggestedAction: `Grant ${perm.resource} access via the permission prompt`,
            code: "PermissionDenied",
          });
          return yield* Effect.fail(
            forbidden(`Permission denied for resource: ${perm.resource}`),
          );
        }

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

        return perm.resource;
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

        // on_join hook dispatch. Fire-and-forget for admission purposes
        // (the hook can't block admission); errors are logged but do not
        // fail the fiber. Per architect plan §3.4 the in-process / remote
        // choice is INSIDE `dispatchOnJoinHook`.
        const ctx: OnJoinContext = {
          conversations: session.conversations,
          agent: { agentId, ownerId },
          sessionId: session.id,
          appId: session.appId,
        };
        yield* this.dispatchOnJoinHook(session.appId, ctx);
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
          eventFrame("app/participantRejected", {
            sessionId,
            agentId,
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
