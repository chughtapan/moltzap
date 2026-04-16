import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager } from "../ws/connection.js";
import type { ConversationService } from "../services/conversation.service.js";
import type { UserService } from "../services/user.service.js";
import type { Logger } from "../logger.js";
import type { AppManifest, AppSession, Part } from "@moltzap/protocol";
import { ErrorCodes, EventNames, eventFrame } from "@moltzap/protocol";
import type {
  AppHooks,
  BeforeMessageDeliveryContext,
  BeforeMessageDeliveryHook,
  HookResult,
  OnJoinHook,
} from "./hooks.js";
import { RpcError } from "../rpc/router.js";

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
  areInContact(userIdA: string, userIdB: string): Promise<boolean>;
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
  }): Promise<string[]>;
}

export class NotInContactsError extends Error {
  constructor() {
    super("Not in contacts");
    this.name = "NotInContactsError";
  }
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

export class DefaultPermissionService implements PermissionService {
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
  private userService: UserService | null = null;
  private contactService: ContactService | null = null;
  private permissionService: PermissionService | null = null;
  private inflightPermissions = new Map<string, Promise<string[]>>();
  private hooks = new Map<string, AppHooks>();
  private conversationToSession = new Map<
    string,
    { id: string; appId: string }
  >();

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

  setUserService(service: UserService): void {
    this.userService = service;
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

  onAppJoin(appId: string, handler: OnJoinHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.onJoin = handler;
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

    const uniqueInvitedIds = [...new Set(invitedAgentIds)];
    const allAgentIds = [initiatorAgentId, ...uniqueInvitedIds];
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

    // Validate initiator's user before persisting anything
    if (this.userService) {
      const { valid } = await this.userService.validateUser(
        initiator.owner_user_id,
      );
      if (!valid) {
        throw new RpcError(
          ErrorCodes.Forbidden,
          "Initiator user failed validation",
        );
      }
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

      const initialStatus =
        uniqueInvitedIds.length === 0 ? "active" : "waiting";
      await trx
        .insertInto("app_sessions")
        .values({
          id: sessionId,
          app_id: appId,
          initiator_agent_id: initiatorAgentId,
          status: initialStatus,
        })
        .execute();

      // Only insert participant rows for agents that exist in the DB
      // (non-existent agents will be rejected during admission)
      const knownInvitees = uniqueInvitedIds.filter((id) => agentMap.has(id));
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

    for (const convId of Object.values(conversationMap)) {
      this.conversationToSession.set(convId, { id: sessionId, appId });
    }

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
      this.admitAgentsAsync(
        session,
        manifest,
        initiatorAgentId,
        uniqueInvitedIds,
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

  private subscribeToConversation(agentId: string, convId: string): void {
    for (const conn of this.connections.getByAgent(agentId)) {
      conn.conversationIds.add(convId);
    }
  }

  private async runWithTimeout(
    fn: (ctx: BeforeMessageDeliveryContext) => HookResult | Promise<HookResult>,
    ctx: Omit<BeforeMessageDeliveryContext, "signal">,
    timeoutMs: number,
  ): Promise<HookResult | null> {
    const controller = new AbortController();
    const ctxWithSignal: BeforeMessageDeliveryContext = {
      ...ctx,
      signal: controller.signal,
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(fn(ctxWithSignal)),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(null);
          }, timeoutMs);
        }),
      ]);
      return result;
    } catch (err) {
      controller.abort();
      this.logger.error({ err }, "Hook execution error");
      return null;
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
    // Cache UserService results per ownerUserId to avoid redundant webhook calls
    const userValidationCache = new Map<string, Promise<{ valid: boolean }>>();

    const checkDone = () => {
      if (resolved.size < total) return;

      const allRejected = [...resolved.values()].every((s) => s === "rejected");
      const finalStatus = allRejected ? "failed" : "active";

      this.db
        .updateTable("app_sessions")
        .set({ status: finalStatus })
        .where("id", "=", session.id)
        .execute()
        .catch((err) =>
          this.logger.error(
            { err, sessionId: session.id },
            "Failed to update session status",
          ),
        );

      if (allRejected) {
        this.broadcaster.sendToAgent(
          initiatorAgentId,
          eventFrame("app/sessionFailed", {
            sessionId: session.id,
          }),
        );
        this.logger.warn(
          { sessionId: session.id },
          "All agents rejected — session failed",
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
    };

    for (const agentId of invitedAgentIds) {
      this.admitAgent(
        session,
        manifest,
        initiatorAgentId,
        agentId,
        agentMap,
        userValidationCache,
      )
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
    userValidationCache: Map<string, Promise<{ valid: boolean }>>,
  ): Promise<void> {
    const agent = agentMap.get(agentId);
    if (!agent) {
      await this.rejectAgent(
        session.id,
        agentId,
        "identity",
        "Agent not found",
        undefined,
        "AgentNotFound",
      );
      throw new Error("Agent not found");
    }

    // User, identity, and capability checks are independent — run concurrently.
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

    const checks: Promise<void>[] = [
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

    // User validation (cached per ownerUserId)
    if (this.userService && agent.owner_user_id) {
      const userId = agent.owner_user_id;
      if (!userValidationCache.has(userId)) {
        userValidationCache.set(userId, this.userService.validateUser(userId));
      }
      checks.push(
        userValidationCache.get(userId)!.then(async ({ valid }) => {
          if (!valid) {
            await guardedReject(
              session.id,
              agentId,
              "user",
              "User validation failed",
              undefined,
              "UserInvalid",
            );
            throw new Error("User invalid");
          }
        }),
      );
    }

    const results = await Promise.allSettled(checks);

    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }

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
        "AgentNoOwner",
      );
      throw new Error("Agent has no owner");
    }

    if (!this.contactService) return; // default: allow all

    try {
      const inContact = await this.contactService.areInContact(
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
          "NotInContacts",
        );
        throw new NotInContactsError();
      }
    } catch (err) {
      if (err instanceof NotInContactsError) throw err;
      await reject(
        session.id,
        agentId,
        "identity",
        `Contact check error: ${errorMessage(err)}`,
        undefined,
        "ContactCheckFailed",
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
          ? "AttestationTimeout"
          : "SkillMismatch";
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
        "SkillMismatch",
      );
      throw new Error("Skill mismatch");
    }

    if (
      manifest.skillMinVersion &&
      compareSemver(result.version, manifest.skillMinVersion) < 0
    ) {
      await reject(
        session.id,
        agentId,
        "capability",
        `Skill version ${result.version} below minimum ${manifest.skillMinVersion}`,
        undefined,
        "SkillVersionTooOld",
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

    const allResources = [
      ...manifest.permissions.required,
      ...manifest.permissions.optional,
    ].map((p) => p.resource);
    const existingGrants = new Map<string, string[]>();
    if (allResources.length > 0) {
      const rows = await this.db
        .selectFrom("app_permission_grants")
        .select(["resource", "access"])
        .where("user_id", "=", ownerUserId)
        .where("app_id", "=", session.appId)
        .where("resource", "in", allResources)
        .execute();
      for (const row of rows) {
        existingGrants.set(row.resource, row.access);
      }
    }

    for (const perm of manifest.permissions.required) {
      const storedAccess = existingGrants.get(perm.resource);
      const covers =
        storedAccess && perm.access.every((a) => new Set(storedAccess).has(a));

      if (covers) {
        granted.push(perm.resource);
        continue;
      }

      if (!this.permissionService) {
        await this.rejectAgent(
          session.id,
          agentId,
          "permission",
          `No permission handler configured for resource: ${perm.resource}`,
          "Server must configure a PermissionService to process permission requests",
          "NoPermissionHandler",
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

        const promise = this.permissionService
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
              ? "PermissionTimeout"
              : "PermissionDenied";
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
          "PermissionHandlerError",
        );
        throw new PermissionDeniedError(perm.resource);
      }
    }

    for (const perm of manifest.permissions.optional) {
      const storedAccess = existingGrants.get(perm.resource);
      const covers =
        storedAccess && perm.access.every((a) => new Set(storedAccess).has(a));
      if (covers) {
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
