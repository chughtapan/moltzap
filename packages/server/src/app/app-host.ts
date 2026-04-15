import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager } from "../ws/connection.js";
import type { ConversationService } from "../services/conversation.service.js";
import type { Logger } from "../logger.js";
import type { AppManifest, AppSession } from "@moltzap/protocol";
import { ErrorCodes, eventFrame } from "@moltzap/protocol";
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
        eventFrame("permissions/required", {
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
    });

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

  /** Cancel all pending timers. Called on shutdown. */
  destroy(): void {
    for (const pending of this.pendingChallenges.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingChallenges.clear();
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
  ): Promise<{ numDeletedRows: bigint }> {
    const result = await this.db
      .deleteFrom("app_permission_grants")
      .where("user_id", "=", userId)
      .where("app_id", "=", appId)
      .where("resource", "=", resource)
      .executeTakeFirst();

    return { numDeletedRows: result.numDeletedRows };
  }

  private subscribeToConversation(agentId: string, convId: string): void {
    for (const conn of this.connections.getByAgent(agentId)) {
      conn.conversationIds.add(convId);
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

    // Identity and capability checks are independent — run concurrently
    await Promise.all([
      this.checkIdentity(session, initiatorAgentId, agentId, agentMap),
      manifest.skillUrl
        ? this.checkCapability(session, agentId, manifest)
        : Promise.resolve(),
    ]);

    const grantedResources = await this.checkPermissions(
      session,
      agentId,
      manifest,
      agentMap,
    );

    await this.admitAgentToSession(session, agentId, grantedResources);
  }

  private async checkIdentity(
    session: AppSession,
    initiatorAgentId: string,
    agentId: string,
    agentMap: Map<
      string,
      { id: string; owner_user_id: string | null; status: string }
    >,
  ): Promise<void> {
    const agent = agentMap.get(agentId)!;
    const initiator = agentMap.get(initiatorAgentId)!;

    if (!agent.owner_user_id) {
      await this.rejectAgent(
        session.id,
        agentId,
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
        await this.rejectAgent(
          session.id,
          agentId,
          "identity",
          "Agent owner is not a contact of the session initiator's owner",
        );
        throw new Error("Not in contacts");
      }
    } catch (err) {
      if (errorMessage(err) === "Not in contacts") throw err;
      await this.rejectAgent(
        session.id,
        agentId,
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
      await this.rejectAgent(
        session.id,
        agentId,
        "capability",
        reason,
        `Install the skill from ${manifest.skillUrl} and ensure version >= ${manifest.skillMinVersion ?? "any"}`,
      );
      throw err;
    });

    // Verify the attestation
    if (result.skillUrl !== manifest.skillUrl) {
      await this.rejectAgent(
        session.id,
        agentId,
        "capability",
        `Skill URL mismatch: expected ${manifest.skillUrl}, got ${result.skillUrl}`,
      );
      throw new Error("Skill mismatch");
    }

    if (manifest.skillMinVersion && result.version < manifest.skillMinVersion) {
      await this.rejectAgent(
        session.id,
        agentId,
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
          await this.rejectAgent(
            session.id,
            agentId,
            "permission",
            `Insufficient access granted for resource: ${perm.resource}`,
            `Required: ${perm.access.join(", ")}; granted: ${access.join(", ")}`,
            "permission_denied",
          );
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
      // "initiator" and "none" don't add the invited agent
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
