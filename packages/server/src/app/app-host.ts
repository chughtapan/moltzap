import type { Kysely } from "kysely";
import type { AppSessionStatus, Database } from "../db/database.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager } from "../ws/connection.js";
import type { ConversationService } from "../services/conversation.service.js";
import type { Logger } from "../logger.js";
import type { AppManifest, AppSession, Part } from "@moltzap/protocol";
import { ErrorCodes, eventFrame } from "@moltzap/protocol";
import type {
  AppHooks,
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

export class AppHost {
  private pendingChallenges = new Map<string, PendingChallenge>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private manifests = new Map<string, AppManifest>();
  private contactChecker: ContactChecker | null = null;
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

  onSessionClose(appId: string, handler: OnCloseHook): void {
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

    const outcome = await this.runHookWithTimeout(
      (signal) => appHooks.beforeMessageDelivery!({ ...ctx, signal }),
      timeoutMs,
    );

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
      this.logger.warn(
        { sessionId: session.id, appId: session.appId, timeoutMs },
        "before_message_delivery hook timed out",
      );
      return null;
    }

    if (!outcome.result) return null;

    return { result: outcome.result, appId: session.appId };
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

  async closeSession(
    sessionId: string,
    callerAgentId: string,
  ): Promise<{ closed: boolean }> {
    // 1. Look up session
    const sessionRow = await this.db
      .selectFrom("app_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst();

    if (!sessionRow) {
      throw new RpcError(ErrorCodes.SessionNotFound, "Session not found");
    }
    if (sessionRow.status === "closed") {
      throw new RpcError(ErrorCodes.SessionClosed, "Session is already closed");
    }

    // 2. Only initiator can close
    if (sessionRow.initiator_agent_id !== callerAgentId) {
      throw new RpcError(
        ErrorCodes.Forbidden,
        "Only the session initiator can close the session",
      );
    }

    // 2b. Atomic claim: prevents concurrent close race
    const claimed = await this.db
      .updateTable("app_sessions")
      .set({ status: "closed", closed_at: new Date() })
      .where("id", "=", sessionId)
      .where("status", "!=", "closed")
      .executeTakeFirst();
    if (BigInt(claimed.numUpdatedRows) === 0n) {
      throw new RpcError(ErrorCodes.SessionClosed, "Session is already closed");
    }

    // 3. Get admitted participants for broadcast
    const participantRows = await this.db
      .selectFrom("app_session_participants")
      .select("agent_id")
      .where("session_id", "=", sessionId)
      .where("status", "=", "admitted")
      .execute();
    const participantAgentIds = participantRows.map((r) => r.agent_id);

    // 4. Get conversation mappings (single query, used for both convIds and hook context)
    const convEntries = await this.db
      .selectFrom("app_session_conversations")
      .select(["conversation_key", "conversation_id"])
      .where("session_id", "=", sessionId)
      .execute();
    const conversations: Record<string, string> = Object.fromEntries(
      convEntries.map((r) => [r.conversation_key, r.conversation_id]),
    );
    const convIds =
      this.sessionToConversations.get(sessionId) ??
      new Set(convEntries.map((r) => r.conversation_id));

    // 5. Fire on_close hook with timeout (fail-open)
    const appHooks = this.hooks.get(sessionRow.app_id);
    if (appHooks?.onClose) {
      const manifest = this.manifests.get(sessionRow.app_id);
      const timeoutMs = manifest?.hooks?.on_close?.timeout_ms ?? 5000;

      const initiator = await this.db
        .selectFrom("agents")
        .select("owner_user_id")
        .where("id", "=", callerAgentId)
        .executeTakeFirst();

      const outcome = await this.runHookWithTimeout(
        (signal) =>
          appHooks.onClose!({
            sessionId,
            appId: sessionRow.app_id,
            conversations,
            closedBy: {
              agentId: callerAgentId,
              ownerId: initiator?.owner_user_id ?? "",
            },
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
        this.logger.warn(
          { sessionId, appId: sessionRow.app_id, timeoutMs },
          "on_close hook timed out",
        );
      }
    }

    // 6-7a. Archive conversations (session already marked closed in step 2b)
    const convIdArray = [...convIds];
    if (convIdArray.length > 0) {
      await this.db
        .updateTable("conversations")
        .set({ archived_at: new Date() })
        .where("id", "in", convIdArray)
        .execute();
    }

    // 7b-7c. Prune in-memory maps
    for (const convId of convIdArray) {
      this.conversationToSession.delete(convId);
    }
    this.sessionToConversations.delete(sessionId);

    // 7d. Unsubscribe all agents from closed conversations
    const allAgentIds = [callerAgentId, ...participantAgentIds];
    for (const agentId of allAgentIds) {
      for (const convId of convIdArray) {
        this.unsubscribeFromConversation(agentId, convId);
      }
    }

    // 8. Broadcast app/sessionClosed to initiator + admitted participants
    const closedEvent = eventFrame("app/sessionClosed", {
      sessionId,
      closedBy: callerAgentId,
    });
    this.broadcaster.sendToAgent(callerAgentId, closedEvent);
    for (const agentId of participantAgentIds) {
      this.broadcaster.sendToAgent(agentId, closedEvent);
    }

    return { closed: true };
  }

  async getSession(
    sessionId: string,
    callerAgentId: string,
  ): Promise<AppSession> {
    const sessionRow = await this.db
      .selectFrom("app_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst();

    if (!sessionRow) {
      throw new RpcError(ErrorCodes.SessionNotFound, "Session not found");
    }

    // Accessible to initiator or admitted participants
    const isInitiator = sessionRow.initiator_agent_id === callerAgentId;
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
          "Only the initiator or admitted participants can view this session",
        );
      }
    }

    // Hydrate conversations from DB join table
    const convRows = await this.db
      .selectFrom("app_session_conversations")
      .select(["conversation_key", "conversation_id"])
      .where("session_id", "=", sessionId)
      .execute();
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
  }

  async listSessions(
    callerAgentId: string,
    opts?: { appId?: string; status?: string; limit?: number },
  ): Promise<AppSession[]> {
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

    const rows = await query.execute();

    return rows.map((row) => {
      const session: AppSession = {
        id: row.id,
        appId: row.app_id,
        initiatorAgentId: row.initiator_agent_id,
        status: row.status,
        conversations: {},
        createdAt: new Date(row.created_at as unknown as string).toISOString(),
      };
      if (row.closed_at) {
        session.closedAt = new Date(
          row.closed_at as unknown as string,
        ).toISOString();
      }
      return session;
    });
  }

  /** Cancel all pending timers and clear state. Called on shutdown. */
  destroy(): void {
    for (const pending of this.pendingChallenges.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingChallenges.clear();
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timer);
      pending.reject("shutdown");
    }
    this.pendingPermissions.clear();
    this.hooks.clear();
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

  private async runHookWithTimeout<T>(
    fn: (signal: AbortSignal) => T | Promise<T>,
    timeoutMs: number,
  ): Promise<
    | { result: T; timedOut: false }
    | { result: null; timedOut: true }
    | { result: null; timedOut: false }
  > {
    const controller = new AbortController();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
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
      return result;
    } catch (err) {
      controller.abort();
      this.logger.error({ err }, "Hook execution error");
      return { result: null, timedOut: false };
    } finally {
      clearTimeout(timer);
    }
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
      );
      return;
    }

    // Identity and capability checks are independent — run concurrently.
    // Guard prevents duplicate rejection events if both fail.
    let rejected = false;
    const guardedReject = async (
      stage: "identity" | "capability",
      reason: string,
      suggestedAction?: string,
    ) => {
      if (rejected) return;
      rejected = true;
      await this.rejectAgent(
        session.id,
        agentId,
        stage,
        reason,
        suggestedAction,
      );
    };

    const results = await Promise.allSettled([
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

    const failure = results.find((r) => r.status === "rejected");
    if (failure) throw (failure as PromiseRejectedResult).reason;

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
    guardedReject: (
      stage: "identity" | "capability",
      reason: string,
      suggestedAction?: string,
    ) => Promise<void>,
  ): Promise<void> {
    const agent = agentMap.get(agentId)!;
    const initiator = agentMap.get(initiatorAgentId)!;

    if (!agent.owner_user_id) {
      await guardedReject(
        "identity",
        "Agent has no owner_user_id",
        "Set owner_user_id on the agent before inviting it to app sessions",
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
        await guardedReject(
          "identity",
          "Agent owner is not a contact of the session initiator's owner",
        );
        throw new Error("Not in contacts");
      }
    } catch (err) {
      if (errorMessage(err) === "Not in contacts") throw err;
      await guardedReject(
        "identity",
        `ContactChecker error: ${errorMessage(err)}`,
      );
      throw err;
    }
  }

  private async checkCapability(
    session: AppSession,
    agentId: string,
    manifest: AppManifest,
    guardedReject: (
      stage: "identity" | "capability",
      reason: string,
      suggestedAction?: string,
    ) => Promise<void>,
  ): Promise<void> {
    const challengeId = crypto.randomUUID();
    const timeoutMs = manifest.challengeTimeoutMs ?? 30000;

    const result = await new Promise<{ skillUrl: string; version: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingChallenges.delete(challengeId);
          reject(new Error("attestation timeout"));
        }, timeoutMs);

        this.pendingChallenges.set(challengeId, {
          targetAgentId: agentId,
          sessionId: session.id,
          resolve,
          reject: (reason: string) => reject(new Error(reason)),
          timer,
        });

        // Send challenge to the agent
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
      const reason =
        errorMessage(err) === "attestation timeout"
          ? "Skill attestation timed out"
          : `Skill attestation failed: ${errorMessage(err)}`;
      await guardedReject(
        "capability",
        reason,
        `Install the skill from ${manifest.skillUrl} and ensure version >= ${manifest.skillMinVersion ?? "any"}`,
      );
      throw err;
    });

    // Verify the attestation
    if (result.skillUrl !== manifest.skillUrl) {
      await guardedReject(
        "capability",
        `Skill URL mismatch: expected ${manifest.skillUrl}, got ${result.skillUrl}`,
      );
      throw new Error("Skill mismatch");
    }

    if (manifest.skillMinVersion && result.version < manifest.skillMinVersion) {
      await guardedReject(
        "capability",
        `Skill version ${result.version} below minimum ${manifest.skillMinVersion}`,
      );
      throw new Error("Skill version too low");
    }
  }

  private async findGrant(
    userId: string,
    appId: string,
    resource: string,
  ): Promise<{ access: string[] } | undefined> {
    return this.db
      .selectFrom("app_permission_grants")
      .select("access")
      .where("user_id", "=", userId)
      .where("app_id", "=", appId)
      .where("resource", "=", resource)
      .executeTakeFirst();
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
      );

      if (existing) {
        const storedAccess = new Set(existing.access);
        const covers = perm.access.every((a) => storedAccess.has(a));
        if (covers) {
          granted.push(perm.resource);
          continue;
        }
      }

      const permKey = `${session.id}:${agentId}:${perm.resource}`;
      const requestId = crypto.randomUUID();
      const timeoutMs = manifest.permissionTimeoutMs ?? 120000;

      try {
        const access = await new Promise<string[]>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingPermissions.delete(permKey);
            reject(new Error("permission timeout"));
          }, timeoutMs);

          this.pendingPermissions.set(permKey, {
            targetUserId: ownerUserId,
            agentId,
            sessionId: session.id,
            appId: session.appId,
            resource: perm.resource,
            resolve,
            reject: (reason: string) => reject(new Error(reason)),
            timer,
          });

          // Send permission request to the agent (agent's owner grants via apps/grantPermission)
          this.broadcaster.sendToAgent(
            agentId,
            eventFrame("app/permissionRequest", {
              sessionId: session.id,
              appId: session.appId,
              resource: perm.resource,
              access: perm.access,
              requestId,
              targetUserId: ownerUserId,
            }),
          );
        });

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
        this.logger.warn(
          { err, sessionId: session.id, resource: perm.resource },
          "Permission grant failed",
        );
        await this.rejectAgent(
          session.id,
          agentId,
          "permission",
          `Permission timeout for resource: ${perm.resource}`,
          `Grant ${perm.resource} access via the permission prompt`,
        );
        throw new Error("Permission denied");
      }
    }

    for (const perm of manifest.permissions.optional) {
      const existing = await this.findGrant(
        ownerUserId,
        session.appId,
        perm.resource,
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
      }),
    );

    this.logger.info(
      { sessionId, agentId, stage, reason },
      "Agent rejected from app session",
    );
  }
}
