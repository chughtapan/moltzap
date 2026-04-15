import type { Kysely } from "kysely";
import type { Database, AppSessionStatus } from "../db/database.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager } from "../ws/connection.js";
import type { ConversationService } from "../services/conversation.service.js";
import type { Logger } from "../logger.js";
import type { AppManifest, Part } from "@moltzap/protocol";
import {
  ErrorCodes,
  EventNames,
  eventFrame,
  type AppSession,
} from "@moltzap/protocol";
import type {
  AppHooks,
  BeforeMessageDeliveryContext,
  BeforeMessageDeliveryHook,
  HookResult,
  OnCloseHook,
  OnJoinHook,
} from "./hooks.js";
import { RpcError } from "../rpc/router.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ContactChecker {
  areInContact(userIdA: string, userIdB: string): Promise<boolean>;
}

export interface PermissionHandler {
  requestPermission(params: {
    userId: string;
    agentId: string;
    sessionId: string;
    appId: string;
    resource: string;
    access: string[];
    timeoutMs: number;
  }): Promise<string[]>;
}

export class PermissionDeniedError extends Error {
  constructor(resource: string) {
    super(`Permission denied for resource: ${resource}`);
    this.name = "PermissionDeniedError";
  }
}

export class PermissionTimeoutError extends Error {
  constructor(resource: string) {
    super(`Permission timeout for resource: ${resource}`);
    this.name = "PermissionTimeoutError";
  }
}

interface PendingChallenge {
  targetAgentId: string;
  sessionId: string;
  resolve: (result: { skillUrl: string; version: string }) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingPermission {
  targetUserId: string;
  agentId: string;
  sessionId: string;
  appId: string;
  resource: string;
  resolve: (access: string[]) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DefaultPermissionHandler implements PermissionHandler {
  private pendingPermissions = new Map<string, PendingPermission>();

  constructor(
    private broadcaster: Broadcaster,
    private logger: Logger,
  ) {}

  async requestPermission(params: {
    userId: string;
    agentId: string;
    sessionId: string;
    appId: string;
    resource: string;
    access: string[];
    timeoutMs: number;
  }): Promise<string[]> {
    const requestId = crypto.randomUUID();
    const key = `${params.sessionId}:${params.agentId}:${params.resource}`;

    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(key);
        reject(new PermissionTimeoutError(params.resource));
      }, params.timeoutMs);

      this.pendingPermissions.set(key, {
        targetUserId: params.userId,
        agentId: params.agentId,
        sessionId: params.sessionId,
        appId: params.appId,
        resource: params.resource,
        resolve,
        reject: (reason: string) => reject(new PermissionDeniedError(reason)),
        timer,
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
    });
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
      this.logger.warn(
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

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(key);
    pending.resolve(access);
  }

  destroy(): void {
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timer);
      pending.reject("shutdown");
    }
    this.pendingPermissions.clear();
  }
}

export class AppHost {
  private pendingChallenges = new Map<string, PendingChallenge>();
  private manifests = new Map<string, AppManifest>();
  private contactChecker: ContactChecker | null = null;
  private permissionHandler: PermissionHandler | null = null;
  private inflightPermissions = new Map<string, Promise<string[]>>();
  private hooks = new Map<string, AppHooks>();
  private conversationToSession = new Map<
    string,
    { id: string; appId: string }
  >();
  private sessionToConversations = new Map<string, Record<string, string>>();

  constructor(
    private db: Kysely<Database>,
    private broadcaster: Broadcaster,
    private connections: ConnectionManager,
    private conversationService: ConversationService,
    private logger: Logger,
  ) {}

  registerApp(manifest: AppManifest): void {
    this.manifests.set(manifest.appId, manifest);
    this.logger.info({ appId: manifest.appId }, "App registered");
  }

  getManifest(appId: string): AppManifest | undefined {
    return this.manifests.get(appId);
  }

  setContactChecker(checker: ContactChecker): void {
    this.contactChecker = checker;
  }

  setPermissionHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  onBeforeMessageDelivery(
    appId: string,
    handler: BeforeMessageDeliveryHook,
  ): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.beforeMessageDelivery = handler;
    this.hooks.set(appId, existing);
  }

  onAppJoin(appId: string, handler: OnJoinHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.onJoin = handler;
    this.hooks.set(appId, existing);
  }

  onAppClose(appId: string, handler: OnCloseHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.onClose = handler;
    this.hooks.set(appId, existing);
  }

  async runBeforeMessageDelivery(
    conversationId: string,
    senderAgentId: string,
    parts: Part[],
    replyToId?: string,
  ): Promise<{ result: HookResult; appId: string } | null> {
    const session = this.conversationToSession.get(conversationId);
    if (!session) return null;

    const appHooks = this.hooks.get(session.appId);
    if (!appHooks?.beforeMessageDelivery) return null;

    const agent = await this.db
      .selectFrom("agents")
      .select("owner_user_id")
      .where("id", "=", senderAgentId)
      .executeTakeFirst();

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

    const manifest = this.manifests.get(session.appId);
    const timeoutMs =
      manifest?.hooks?.before_message_delivery?.timeout_ms ?? 5000;

    const result = await this.runWithTimeout(
      appHooks.beforeMessageDelivery,
      ctx,
      timeoutMs,
    );
    if (!result) return null;
    return { result, appId: session.appId };
  }

  async createSession(
    appId: string,
    initiatorAgentId: string,
    invitedAgentIds: string[],
  ): Promise<AppSession> {
    const manifest = this.manifests.get(appId);
    if (!manifest) {
      throw new RpcError(
        ErrorCodes.AppNotFound,
        `Unknown app: ${appId}. Call registerApp({ appId: '${appId}', ... }) before creating sessions.`,
      );
    }

    const maxParticipants = manifest.limits?.maxParticipants ?? 50;
    if (invitedAgentIds.length > maxParticipants) {
      throw new RpcError(
        ErrorCodes.MaxParticipants,
        `Invited ${invitedAgentIds.length} agents but app limit is ${maxParticipants}`,
      );
    }

    const allAgentIds = [initiatorAgentId, ...invitedAgentIds];
    const agentRows = await this.db
      .selectFrom("agents")
      .select(["id", "owner_user_id", "status"])
      .where("id", "in", allAgentIds)
      .execute();

    const agentMap = new Map(agentRows.map((r) => [r.id, r]));

    const initiator = agentMap.get(initiatorAgentId);
    if (!initiator) {
      throw new RpcError(ErrorCodes.AgentNotFound, "Initiator agent not found");
    }
    if (!initiator.owner_user_id) {
      throw new RpcError(
        ErrorCodes.AgentNoOwner,
        "Initiator agent has no owner_user_id. Agents must have an owner to participate in app sessions. Set owner_user_id on the agent.",
      );
    }

    const sessionId = crypto.randomUUID();
    const conversationMap: Record<string, string> = {};

    await this.db.transaction().execute(async (trx) => {
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

      const initialStatus = invitedAgentIds.length === 0 ? "active" : "waiting";
      await trx
        .insertInto("app_sessions")
        .values({
          id: sessionId,
          app_id: appId,
          initiator_agent_id: initiatorAgentId,
          status: initialStatus,
        })
        .execute();

      if (invitedAgentIds.length > 0) {
        await trx
          .insertInto("app_session_participants")
          .values(
            invitedAgentIds.map((agentId) => ({
              session_id: sessionId,
              agent_id: agentId,
              status: "pending" as const,
              rejection_reason: null,
              admitted_at: null,
            })),
          )
          .execute();
      }

      // Persist session → conversation mapping
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
    });

    for (const convId of Object.values(conversationMap)) {
      this.conversationToSession.set(convId, { id: sessionId, appId });
    }
    this.sessionToConversations.set(sessionId, conversationMap);

    const session: AppSession = {
      id: sessionId,
      appId,
      initiatorAgentId,
      status: invitedAgentIds.length === 0 ? "active" : "waiting",
      conversations: conversationMap,
      createdAt: new Date().toISOString(),
    };

    if (invitedAgentIds.length === 0) {
      session.status = "active";
      this.broadcaster.sendToAgent(
        initiatorAgentId,
        eventFrame("app/sessionReady", {
          sessionId,
          conversations: conversationMap,
        }),
      );
    } else {
      this.admitAgentsAsync(
        session,
        manifest,
        initiatorAgentId,
        invitedAgentIds,
        agentMap,
      );
    }

    return session;
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
      this.logger.warn(
        { challengeId, expected: pending.targetAgentId, got: callerAgentId },
        "Skill attestation from wrong agent",
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pendingChallenges.delete(challengeId);
    pending.resolve({ skillUrl, version });
  }

  /** Cancel all pending timers and clear state. Called on shutdown. */
  destroy(): void {
    for (const pending of this.pendingChallenges.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingChallenges.clear();
    this.inflightPermissions.clear();
    this.hooks.clear();
    this.conversationToSession.clear();
    this.sessionToConversations.clear();
  }

  async listGrants(
    userId: string,
    appId?: string,
  ): Promise<
    Array<{
      appId: string;
      resource: string;
      access: string[];
      grantedAt: string;
    }>
  > {
    let query = this.db
      .selectFrom("app_permission_grants")
      .select(["app_id", "resource", "access", "granted_at"])
      .where("user_id", "=", userId);

    if (appId) {
      query = query.where("app_id", "=", appId);
    }

    const rows = await query.execute();
    return rows.map((r) => ({
      appId: r.app_id,
      resource: r.resource,
      access: r.access,
      grantedAt: new Date(r.granted_at).toISOString(),
    }));
  }

  async revokeGrant(
    userId: string,
    appId: string,
    resource: string,
  ): Promise<void> {
    await this.db
      .deleteFrom("app_permission_grants")
      .where("user_id", "=", userId)
      .where("app_id", "=", appId)
      .where("resource", "=", resource)
      .executeTakeFirst();
  }

  async closeSession(
    sessionId: string,
    callerAgentId: string,
  ): Promise<{ closed: true }> {
    // Step 1: Load session
    const session = await this.db
      .selectFrom("app_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst();

    if (!session) {
      throw new RpcError(ErrorCodes.SessionNotFound, "Session not found");
    }
    if (session.status === "closed") {
      throw new RpcError(ErrorCodes.SessionClosed, "Session already closed");
    }

    // Step 2: Verify caller is initiator
    if (session.initiator_agent_id !== callerAgentId) {
      throw new RpcError(
        ErrorCodes.Forbidden,
        "Only the session initiator can close the session",
      );
    }

    // Step 3: Get admitted participants for broadcast
    const participantRows = await this.db
      .selectFrom("app_session_participants")
      .select("agent_id")
      .where("session_id", "=", sessionId)
      .where("status", "=", "admitted")
      .execute();
    const participantAgentIds = participantRows.map((r) => r.agent_id);

    // Step 4: Look up conversations from sessionToConversations map (O(1))
    const conversationMap = this.sessionToConversations.get(sessionId) ?? {};
    const convIds = Object.values(conversationMap);

    // Step 5: Fire on_close hook (fail-open)
    const appHooks = this.hooks.get(session.app_id);
    if (appHooks?.onClose) {
      const agent = await this.db
        .selectFrom("agents")
        .select("owner_user_id")
        .where("id", "=", callerAgentId)
        .executeTakeFirst();

      const manifest = this.manifests.get(session.app_id);
      const timeoutMs = manifest?.hooks?.on_close?.timeout_ms ?? 5000;

      const hookResult = await this.runHookWithTimeout(
        (signal) =>
          appHooks.onClose!({
            sessionId,
            appId: session.app_id,
            conversations: conversationMap,
            closedBy: {
              agentId: callerAgentId,
              ownerId: agent?.owner_user_id ?? "",
            },
            signal,
          }),
        timeoutMs,
      );

      if (hookResult.timedOut) {
        this.logger.warn(
          { sessionId, appId: session.app_id, timeoutMs },
          "on_close hook timed out",
        );
        // Broadcast app/hookTimeout to initiator
        this.broadcaster.sendToAgent(
          callerAgentId,
          eventFrame(EventNames.AppHookTimeout, {
            sessionId,
            appId: session.app_id,
            hookName: "on_close",
            timeoutMs,
          }),
        );
      }
    }

    // Steps 6 + 7a: DB transaction — close session + archive conversations
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("app_sessions")
        .set({ status: "closed", closed_at: new Date() })
        .where("id", "=", sessionId)
        .execute();

      if (convIds.length > 0) {
        await trx
          .updateTable("conversations")
          .set({ archived_at: new Date() })
          .where("id", "in", convIds)
          .execute();
      }
    });

    // Step 7b: Prune conversationToSession entries
    for (const convId of convIds) {
      this.conversationToSession.delete(convId);
    }

    // Step 7c: Prune sessionToConversations entry
    this.sessionToConversations.delete(sessionId);

    // Step 7d: Unsubscribe agents from conversations
    const allAgentIds = [callerAgentId, ...participantAgentIds];
    for (const agentId of allAgentIds) {
      for (const conn of this.connections.getByAgent(agentId)) {
        for (const convId of convIds) {
          conn.conversationIds.delete(convId);
        }
      }
    }

    // Step 8: Broadcast app/sessionClosed
    const closedEvent = eventFrame(EventNames.AppSessionClosed, {
      sessionId,
      closedBy: callerAgentId,
    });
    this.broadcaster.sendToAgent(callerAgentId, closedEvent);
    for (const agentId of participantAgentIds) {
      this.broadcaster.sendToAgent(agentId, closedEvent);
    }

    this.logger.info(
      { sessionId, appId: session.app_id, closedBy: callerAgentId },
      "App session closed",
    );

    // Step 9
    return { closed: true };
  }

  async getSession(
    sessionId: string,
    callerAgentId: string,
  ): Promise<AppSession> {
    const session = await this.db
      .selectFrom("app_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst();

    if (!session) {
      throw new RpcError(ErrorCodes.SessionNotFound, "Session not found");
    }

    // Check caller is initiator or admitted participant
    const isInitiator = session.initiator_agent_id === callerAgentId;
    if (!isInitiator) {
      const participant = await this.db
        .selectFrom("app_session_participants")
        .select("status")
        .where("session_id", "=", sessionId)
        .where("agent_id", "=", callerAgentId)
        .executeTakeFirst();

      if (!participant || participant.status !== "admitted") {
        throw new RpcError(
          ErrorCodes.Forbidden,
          "Not a participant in this session",
        );
      }
    }

    // Load conversations from DB
    const convRows = await this.db
      .selectFrom("app_session_conversations")
      .select(["conversation_key", "conversation_id"])
      .where("session_id", "=", sessionId)
      .execute();

    const conversations: Record<string, string> = {};
    for (const row of convRows) {
      conversations[row.conversation_key] = row.conversation_id;
    }

    return {
      id: session.id,
      appId: session.app_id,
      initiatorAgentId: session.initiator_agent_id,
      status: session.status,
      conversations,
      createdAt: new Date(session.created_at).toISOString(),
      closedAt: session.closed_at
        ? new Date(session.closed_at).toISOString()
        : undefined,
    };
  }

  async listSessions(
    callerAgentId: string,
    appId?: string,
    status?: string,
    limit = 50,
  ): Promise<AppSession[]> {
    let query = this.db
      .selectFrom("app_sessions")
      .selectAll()
      .where("initiator_agent_id", "=", callerAgentId)
      .orderBy("created_at", "desc")
      .limit(limit);

    if (appId) {
      query = query.where("app_id", "=", appId);
    }
    if (status) {
      query = query.where("status", "=", status as AppSessionStatus);
    }

    const rows = await query.execute();

    // Batch-load conversations for all sessions
    const sessionIds = rows.map((r) => r.id);
    const convRows =
      sessionIds.length > 0
        ? await this.db
            .selectFrom("app_session_conversations")
            .select(["session_id", "conversation_key", "conversation_id"])
            .where("session_id", "in", sessionIds)
            .execute()
        : [];

    const convBySession = new Map<string, Record<string, string>>();
    for (const row of convRows) {
      if (!convBySession.has(row.session_id)) {
        convBySession.set(row.session_id, {});
      }
      convBySession.get(row.session_id)![row.conversation_key] =
        row.conversation_id;
    }

    return rows.map((row) => ({
      id: row.id,
      appId: row.app_id,
      initiatorAgentId: row.initiator_agent_id,
      status: row.status,
      conversations: convBySession.get(row.id) ?? {},
      createdAt: new Date(row.created_at).toISOString(),
      closedAt: row.closed_at
        ? new Date(row.closed_at).toISOString()
        : undefined,
    }));
  }

  /** Check if a conversation has been archived (for use in message guards). */
  async isConversationArchived(conversationId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("conversations")
      .select("archived_at")
      .where("id", "=", conversationId)
      .executeTakeFirst();
    return row?.archived_at != null;
  }

  private subscribeToConversation(agentId: string, convId: string): void {
    for (const conn of this.connections.getByAgent(agentId)) {
      conn.conversationIds.add(convId);
    }
  }

  private async runHookWithTimeout<T>(
    fn: (signal: AbortSignal) => T | Promise<T>,
    timeoutMs: number,
  ): Promise<
    { result: T; timedOut: false } | { result: null; timedOut: true }
  > {
    const controller = new AbortController();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raceResult = await Promise.race([
        Promise.resolve(fn(controller.signal)).then((r) => ({
          result: r,
          timedOut: false as const,
        })),
        new Promise<{ result: null; timedOut: true }>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ result: null, timedOut: true });
          }, timeoutMs);
        }),
      ]);
      return raceResult;
    } catch (err) {
      controller.abort();
      this.logger.error({ err }, "Hook execution error");
      // Hook threw — not a timeout, but no result available
      return { result: null, timedOut: true };
    } finally {
      clearTimeout(timer);
    }
  }

  private async runWithTimeout(
    fn: (ctx: BeforeMessageDeliveryContext) => HookResult | Promise<HookResult>,
    ctx: Omit<BeforeMessageDeliveryContext, "signal">,
    timeoutMs: number,
  ): Promise<HookResult | null> {
    const hookResult = await this.runHookWithTimeout(
      (signal) => fn({ ...ctx, signal }),
      timeoutMs,
    );
    return hookResult.timedOut ? null : hookResult.result;
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
  ): void {
    const resolved = new Map<string, "admitted" | "rejected">();
    const total = invitedAgentIds.length;

    const checkDone = () => {
      if (resolved.size < total) return;

      // All agents resolved — mark session active and emit sessionReady
      this.db
        .updateTable("app_sessions")
        .set({ status: "active" })
        .where("id", "=", session.id)
        .execute()
        .catch((err) =>
          this.logger.error(
            { err, sessionId: session.id },
            "Failed to update session status",
          ),
        );

      this.broadcaster.sendToAgent(
        initiatorAgentId,
        eventFrame("app/sessionReady", {
          sessionId: session.id,
          conversations: session.conversations,
        }),
      );
    };

    for (const agentId of invitedAgentIds) {
      this.admitAgent(session, manifest, initiatorAgentId, agentId, agentMap)
        .then(() => {
          resolved.set(agentId, "admitted");
          checkDone();
        })
        .catch((err) => {
          resolved.set(agentId, "rejected");
          this.logger.warn(
            { err, agentId, sessionId: session.id },
            "Agent admission failed",
          );
          checkDone();
        });
    }
  }

  private async admitAgent(
    session: AppSession,
    manifest: AppManifest,
    initiatorAgentId: string,
    agentId: string,
    agentMap: Map<
      string,
      { id: string; owner_user_id: string | null; status: string }
    >,
  ): Promise<void> {
    const agent = agentMap.get(agentId);
    if (!agent) {
      await this.rejectAgent(
        session.id,
        agentId,
        "identity",
        "Agent not found",
        undefined,
        "identity_rejected",
      );
      return;
    }

    // Identity and capability checks are independent — run concurrently.
    // Track whether we've already rejected this agent so concurrent failures
    // don't send duplicate rejection events.
    let rejected = false;
    const guardedReject = async (
      ...args: Parameters<typeof this.rejectAgent>
    ) => {
      if (rejected) return;
      rejected = true;
      await this.rejectAgent(...args);
    };

    const [identityResult, capabilityResult] = await Promise.allSettled([
      this.checkIdentity(
        session,
        initiatorAgentId,
        agentId,
        agentMap,
        guardedReject,
      ),
      manifest.skillUrl
        ? this.checkCapability(session, agentId, manifest, guardedReject)
        : Promise.resolve(),
    ]);

    if (identityResult.status === "rejected") throw identityResult.reason;
    if (capabilityResult.status === "rejected") throw capabilityResult.reason;

    const grantedResources = await this.checkPermissions(
      session,
      agentId,
      manifest,
      agentMap,
    );

    await this.admitAgentToSession(
      session,
      agentId,
      grantedResources,
      agent.owner_user_id ?? "",
    );
  }

  private async checkIdentity(
    session: AppSession,
    initiatorAgentId: string,
    agentId: string,
    agentMap: Map<
      string,
      { id: string; owner_user_id: string | null; status: string }
    >,
    reject: typeof this.rejectAgent = this.rejectAgent.bind(this),
  ): Promise<void> {
    const agent = agentMap.get(agentId)!;
    const initiator = agentMap.get(initiatorAgentId)!;

    if (!agent.owner_user_id) {
      await reject(
        session.id,
        agentId,
        "identity",
        "Agent has no owner_user_id",
        "Set owner_user_id on the agent before inviting it to app sessions",
        "identity_rejected",
      );
      throw new Error("Agent has no owner");
    }

    if (!this.contactChecker) return; // default: allow all

    try {
      const inContact = await this.contactChecker.areInContact(
        initiator.owner_user_id!,
        agent.owner_user_id,
      );
      if (!inContact) {
        await reject(
          session.id,
          agentId,
          "identity",
          "Agent owner is not a contact of the session initiator's owner",
          undefined,
          "identity_rejected",
        );
        throw new Error("Not in contacts");
      }
    } catch (err) {
      if (errorMessage(err) === "Not in contacts") throw err;
      await reject(
        session.id,
        agentId,
        "identity",
        `ContactChecker error: ${errorMessage(err)}`,
        undefined,
        "identity_rejected",
      );
      throw err;
    }
  }

  private async checkCapability(
    session: AppSession,
    agentId: string,
    manifest: AppManifest,
    reject: typeof this.rejectAgent = this.rejectAgent.bind(this),
  ): Promise<void> {
    const challengeId = crypto.randomUUID();
    const timeoutMs = manifest.challengeTimeoutMs ?? 30000;

    const result = await new Promise<{ skillUrl: string; version: string }>(
      (resolve, promiseReject) => {
        const timer = setTimeout(() => {
          this.pendingChallenges.delete(challengeId);
          promiseReject(new Error("attestation timeout"));
        }, timeoutMs);

        this.pendingChallenges.set(challengeId, {
          targetAgentId: agentId,
          sessionId: session.id,
          resolve,
          reject: (reason: string) => promiseReject(new Error(reason)),
          timer,
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
      },
    ).catch(async (err) => {
      const code =
        errorMessage(err) === "attestation timeout"
          ? "capability_timeout"
          : "capability_failed";
      const reason =
        errorMessage(err) === "attestation timeout"
          ? "Skill attestation timed out"
          : `Skill attestation failed: ${errorMessage(err)}`;
      await reject(
        session.id,
        agentId,
        "capability",
        reason,
        `Install the skill from ${manifest.skillUrl} and ensure version >= ${manifest.skillMinVersion ?? "any"}`,
        code,
      );
      throw err;
    });

    if (result.skillUrl !== manifest.skillUrl) {
      await reject(
        session.id,
        agentId,
        "capability",
        `Skill URL mismatch: expected ${manifest.skillUrl}, got ${result.skillUrl}`,
        undefined,
        "capability_failed",
      );
      throw new Error("Skill mismatch");
    }

    if (manifest.skillMinVersion && result.version < manifest.skillMinVersion) {
      await reject(
        session.id,
        agentId,
        "capability",
        `Skill version ${result.version} below minimum ${manifest.skillMinVersion}`,
        undefined,
        "capability_failed",
      );
      throw new Error("Skill version too low");
    }
  }

  private async findGrant(
    userId: string,
    appId: string,
    resource: string,
    requiredAccess: string[],
  ): Promise<{ access: string[] } | undefined> {
    const row = await this.db
      .selectFrom("app_permission_grants")
      .select("access")
      .where("user_id", "=", userId)
      .where("app_id", "=", appId)
      .where("resource", "=", resource)
      .executeTakeFirst();

    if (!row) return undefined;
    // Set-containment: stored access must cover ALL required access
    const stored = new Set(row.access);
    const covers = requiredAccess.every((a) => stored.has(a));
    return covers ? row : undefined;
  }

  private async checkPermissions(
    session: AppSession,
    agentId: string,
    manifest: AppManifest,
    agentMap: Map<
      string,
      { id: string; owner_user_id: string | null; status: string }
    >,
  ): Promise<string[]> {
    const agent = agentMap.get(agentId)!;
    const ownerUserId = agent.owner_user_id!;
    const granted: string[] = [];

    for (const perm of manifest.permissions.required) {
      const existing = await this.findGrant(
        ownerUserId,
        session.appId,
        perm.resource,
        perm.access,
      );

      if (existing) {
        granted.push(perm.resource);
        continue;
      }

      if (!this.permissionHandler) {
        await this.rejectAgent(
          session.id,
          agentId,
          "permission",
          `No permission handler configured for resource: ${perm.resource}`,
          "Server must configure a PermissionHandler to process permission requests",
          "no_handler",
        );
        throw new Error("No permission handler");
      }

      // Coalescing: same userId+appId+resource reuses in-flight promise
      const coalesceKey = `${ownerUserId}:${session.appId}:${perm.resource}`;

      if (!this.inflightPermissions.has(coalesceKey)) {
        this.logger.info(
          {
            sessionId: session.id,
            appId: session.appId,
            resource: perm.resource,
            agentId,
          },
          "Requesting permission from handler",
        );

        const promise = this.permissionHandler
          .requestPermission({
            userId: ownerUserId,
            agentId,
            sessionId: session.id,
            appId: session.appId,
            resource: perm.resource,
            access: perm.access,
            timeoutMs: manifest.permissionTimeoutMs ?? 120000,
          })
          .finally(() => {
            this.inflightPermissions.delete(coalesceKey);
          });

        this.inflightPermissions.set(coalesceKey, promise);
      }

      try {
        const access = await this.inflightPermissions.get(coalesceKey)!;

        this.logger.info(
          { sessionId: session.id, resource: perm.resource, access },
          "Permission handler responded",
        );

        // Post-handler validation: returned access must cover required access
        const returnedSet = new Set(access);
        const covers = perm.access.every((a) => returnedSet.has(a));
        if (!covers) {
          throw new PermissionDeniedError(perm.resource);
        }

        // Store the grant
        await this.db
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
          )
          .execute();

        granted.push(perm.resource);
      } catch (err) {
        this.inflightPermissions.delete(coalesceKey);

        if (
          err instanceof PermissionDeniedError ||
          err instanceof PermissionTimeoutError
        ) {
          const code =
            err instanceof PermissionTimeoutError
              ? "permission_timeout"
              : "permission_denied";
          this.logger.warn(
            {
              err: err.message,
              sessionId: session.id,
              resource: perm.resource,
            },
            "Permission request failed",
          );
          await this.rejectAgent(
            session.id,
            agentId,
            "permission",
            err.message,
            `Grant ${perm.resource} access via the permission prompt`,
            code,
          );
          throw err;
        }

        // Unknown error from handler
        this.logger.error(
          {
            err: errorMessage(err),
            sessionId: session.id,
            resource: perm.resource,
          },
          "Permission handler error",
        );
        await this.rejectAgent(
          session.id,
          agentId,
          "permission",
          `Permission handler error for resource: ${perm.resource}`,
          `Grant ${perm.resource} access via the permission prompt`,
          "permission_denied",
        );
        throw new PermissionDeniedError(perm.resource);
      }
    }

    for (const perm of manifest.permissions.optional) {
      const existing = await this.findGrant(
        ownerUserId,
        session.appId,
        perm.resource,
        perm.access,
      );

      if (existing) {
        granted.push(perm.resource);
      }
    }

    return granted;
  }

  private async admitAgentToSession(
    session: AppSession,
    agentId: string,
    grantedResources: string[],
    ownerId: string,
  ): Promise<void> {
    await this.db
      .updateTable("app_session_participants")
      .set({ status: "admitted", admitted_at: new Date() })
      .where("session_id", "=", session.id)
      .where("agent_id", "=", agentId)
      .execute();

    const manifest = this.manifests.get(session.appId)!;
    for (const convDef of manifest.conversations ?? []) {
      const filter = convDef.participantFilter ?? "all";
      const convId = session.conversations[convDef.key];
      if (!convId) continue;

      if (filter === "all") {
        await this.db
          .insertInto("conversation_participants")
          .values({
            conversation_id: convId,
            agent_id: agentId,
            role: "member",
          })
          .onConflict((oc) => oc.doNothing())
          .execute();

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

    this.logger.info(
      { sessionId: session.id, agentId, grantedResources },
      "Agent admitted to app session",
    );

    const appHooks = this.hooks.get(session.appId);
    if (appHooks?.onJoin) {
      try {
        await appHooks.onJoin({
          conversations: session.conversations,
          agent: { agentId, ownerId },
          sessionId: session.id,
          appId: session.appId,
        });
      } catch (err) {
        this.logger.error(
          { err, sessionId: session.id, agentId },
          "on_join hook error",
        );
      }
    }
  }

  private async rejectAgent(
    sessionId: string,
    agentId: string,
    stage: "identity" | "capability" | "permission",
    reason: string,
    suggestedAction?: string,
    rejectionCode?: string,
  ): Promise<void> {
    await this.db
      .updateTable("app_session_participants")
      .set({ status: "rejected", rejection_reason: reason })
      .where("session_id", "=", sessionId)
      .where("agent_id", "=", agentId)
      .execute();

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

    this.logger.info(
      { sessionId, agentId, stage, reason, rejectionCode },
      "Agent rejected from app session",
    );
  }
}
