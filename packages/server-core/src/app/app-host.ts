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
            created_by_type: "agent",
            created_by_id: initiatorAgentId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        conversationMap[convDef.key] = conv.id;

        await trx
          .insertInto("conversation_participants")
          .values({
            conversation_id: conv.id,
            participant_type: "agent",
            participant_id: initiatorAgentId,
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

      for (const agentId of invitedAgentIds) {
        await trx
          .insertInto("app_session_participants")
          .values({
            session_id: sessionId,
            agent_id: agentId,
            status: "pending",
            rejection_reason: null,
            admitted_at: null,
          })
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
      this.broadcaster.sendToParticipant(
        "agent",
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

  /** Cancel all pending timers. Called on shutdown. */
  destroy(): void {
    for (const pending of this.pendingChallenges.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingChallenges.clear();
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingPermissions.clear();
  }

  private subscribeToConversation(agentId: string, convId: string): void {
    for (const conn of this.connections.getByParticipant("agent", agentId)) {
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

      this.broadcaster.sendToParticipant(
        "agent",
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

    await this.checkIdentity(session, initiatorAgentId, agentId, agentMap);

    if (manifest.skillUrl) {
      await this.checkCapability(session, agentId, manifest);
    }

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
        this.broadcaster.sendToParticipant(
          "agent",
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
        granted.push(perm.resource);
        continue;
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

          this.broadcaster.sendToParticipant(
            "user",
            ownerUserId,
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
      } catch {
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
            participant_type: "agent",
            participant_id: agentId,
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
    this.broadcaster.sendToParticipant("agent", agentId, admittedEvent);
    this.broadcaster.sendToParticipant(
      "agent",
      session.initiatorAgentId,
      admittedEvent,
    );

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
  ): Promise<void> {
    await this.db
      .updateTable("app_session_participants")
      .set({ status: "rejected", rejection_reason: reason })
      .where("session_id", "=", sessionId)
      .where("agent_id", "=", agentId)
      .execute();

    this.broadcaster.sendToParticipant(
      "agent",
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
