import { MoltZapWsClient } from "@moltzap/client";
import type { WsClientLogger, MoltZapWsClientOptions } from "@moltzap/client";
import type {
  AppManifest,
  EventFrame,
  Part,
  Message,
  AppSession,
} from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";
import { AppSessionHandle } from "./session.js";
import { HeartbeatManager } from "./heartbeat.js";
import {
  AppError,
  AuthError,
  ManifestRegistrationError,
  SessionError,
  SessionClosedError,
  ConversationKeyError,
  SendError,
} from "./errors.js";

type MessageHandler = (message: Message) => void | Promise<void>;
type SessionReadyHandler = (session: AppSessionHandle) => void | Promise<void>;
type ParticipantEvent = {
  sessionId: string;
  agentId: string;
};
type ParticipantAdmittedEvent = ParticipantEvent & {
  grantedResources: string[];
};
type ParticipantRejectedEvent = ParticipantEvent & {
  reason: string;
  stage: string;
  rejectionCode: string;
};

export interface MoltZapAppOptions {
  serverUrl: string;
  agentKey: string;
  /** Minimal mode: just provide appId, defaults for everything else */
  appId?: string;
  /** Advanced mode: full manifest */
  manifest?: AppManifest;
  logger?: WsClientLogger;
  /** Application-level heartbeat interval in ms (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Agents to invite when start() is called */
  invitedAgentIds?: string[];
}

/**
 * MoltZapApp — main class for building MoltZap apps.
 *
 * Wraps MoltZapWsClient and manages session lifecycle, message routing,
 * heartbeat, and reconnection.
 */
export class MoltZapApp {
  /** Escape hatch: raw WebSocket client for advanced use */
  readonly client: MoltZapWsClient;

  private readonly manifest: AppManifest;
  private readonly heartbeat: HeartbeatManager;
  private readonly heartbeatIntervalMs: number;
  private readonly invitedAgentIds: string[];
  private readonly logger: WsClientLogger;

  private sessions = new Map<string, AppSessionHandle>();
  /** Reverse map: conversationId -> conversation key */
  private reverseConvMap = new Map<string, string>();
  /** Sessions for which sessionReady handlers have fired (dedup across start() + event) */
  private firedSessionReady = new Set<string>();

  // Event handlers
  private sessionReadyHandlers: SessionReadyHandler[] = [];
  private messageHandlers = new Map<string, MessageHandler>();
  private participantAdmittedHandlers: ((
    event: ParticipantAdmittedEvent,
  ) => void)[] = [];
  private participantRejectedHandlers: ((
    event: ParticipantRejectedEvent,
  ) => void)[] = [];
  private errorHandler: ((error: AppError) => void) | null = null;

  private started = false;

  constructor(options: MoltZapAppOptions) {
    if (!options.appId && !options.manifest) {
      throw new AppError(
        "INVALID_CONFIG",
        "Either appId or manifest must be provided",
      );
    }

    this.manifest = options.manifest ?? {
      appId: options.appId!,
      name: options.appId!,
      permissions: { required: [], optional: [] },
      conversations: [
        { key: "default", name: options.appId!, participantFilter: "all" },
      ],
    };

    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.invitedAgentIds = options.invitedAgentIds ?? [];
    this.logger = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.heartbeat = new HeartbeatManager();

    const wsOptions: MoltZapWsClientOptions = {
      serverUrl: options.serverUrl,
      agentKey: options.agentKey,
      onEvent: (event) => this.handleEvent(event),
      onDisconnect: () => this.handleDisconnect(),
      onReconnect: () => this.handleReconnect(),
      logger: this.logger,
    };

    this.client = new MoltZapWsClient(wsOptions);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<AppSessionHandle> {
    try {
      await this.client.connect();
    } catch (err) {
      throw new AuthError(
        "Failed to connect and authenticate",
        err instanceof Error ? err : undefined,
      );
    }

    // Register manifest
    try {
      await this.client.sendRpc("apps/register", {
        manifest: this.manifest,
      });
    } catch (err) {
      throw new ManifestRegistrationError(
        `Failed to register manifest for "${this.manifest.appId}"`,
        err instanceof Error ? err : undefined,
      );
    }

    // Create session
    let sessionResult: { session: AppSession };
    try {
      sessionResult = (await this.client.sendRpc("apps/create", {
        appId: this.manifest.appId,
        invitedAgentIds: this.invitedAgentIds,
      })) as { session: AppSession };
    } catch (err) {
      throw new SessionError(
        "Failed to create app session",
        err instanceof Error ? err : undefined,
      );
    }

    const handle = new AppSessionHandle(sessionResult.session);
    this.sessions.set(handle.id, handle);
    this.buildReverseConvMap(handle);

    // Start heartbeat
    this.heartbeat.start(
      () => this.sendPing(),
      this.heartbeatIntervalMs,
      (err) => {
        this.logger.warn("Heartbeat ping failed:", err.message);
        this.client.disconnect();
      },
    );

    this.started = true;

    // If session is already active (no admission gates), fire ready handlers
    if (handle.isActive) {
      this.fireSessionReady(handle);
    }

    return handle;
  }

  async stop(): Promise<void> {
    this.heartbeat.destroy();

    // Close all active sessions
    for (const session of this.sessions.values()) {
      if (session.isActive) {
        try {
          await this.client.sendRpc("apps/closeSession", {
            sessionId: session.id,
          });
        } catch {
          // Best effort
        }
      }
    }

    this.sessions.clear();
    this.reverseConvMap.clear();
    this.firedSessionReady.clear();
    this.client.close();
    this.started = false;
  }

  // ── Session management ─────────────────────────────────────────────

  async createSession(invitedAgentIds?: string[]): Promise<AppSessionHandle> {
    const result = (await this.client.sendRpc("apps/create", {
      appId: this.manifest.appId,
      invitedAgentIds: invitedAgentIds ?? [],
    })) as { session: AppSession };

    const handle = new AppSessionHandle(result.session);
    this.sessions.set(handle.id, handle);
    this.buildReverseConvMap(handle);
    return handle;
  }

  getSession(sessionId: string): AppSessionHandle | undefined {
    return this.sessions.get(sessionId);
  }

  get activeSessions(): AppSessionHandle[] {
    return [...this.sessions.values()].filter((s) => s.isActive);
  }

  // ── Event registration ─────────────────────────────────────────────

  onSessionReady(
    handler: (session: AppSessionHandle) => void | Promise<void>,
  ): void {
    this.sessionReadyHandlers.push(handler);
  }

  onMessage(conversationKey: string, handler: MessageHandler): void {
    this.messageHandlers.set(conversationKey, handler);
  }

  onParticipantAdmitted(
    handler: (event: ParticipantAdmittedEvent) => void,
  ): void {
    this.participantAdmittedHandlers.push(handler);
  }

  onParticipantRejected(
    handler: (event: ParticipantRejectedEvent) => void,
  ): void {
    this.participantRejectedHandlers.push(handler);
  }

  onError(handler: (error: AppError) => void): void {
    this.errorHandler = handler;
  }

  // ── Messaging ──────────────────────────────────────────────────────

  /** Send a message to a conversation by key (resolved via session conversation map) */
  async send(conversationKey: string, parts: Part[]): Promise<void> {
    const conversationId = this.resolveConversationKey(conversationKey);
    await this.sendTo(conversationId, parts);
  }

  /** Send a message to a conversation by raw conversation ID */
  async sendTo(conversationId: string, parts: Part[]): Promise<void> {
    try {
      await this.client.sendRpc("messages/send", {
        conversationId,
        parts,
      });
    } catch (err) {
      throw new SendError(
        `Failed to send message to conversation ${conversationId}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Reply to a specific message. The server resolves the target
   * conversation from `replyToId`.
   */
  async reply(messageId: string, parts: Part[]): Promise<void> {
    try {
      await this.client.sendRpc("messages/send", {
        replyToId: messageId,
        parts,
      });
    } catch (err) {
      throw new SendError(
        `Failed to reply to message ${messageId}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  // ── Internal ───────────────────────────────────────────────────────

  private resolveConversationKey(key: string): string {
    for (const session of this.sessions.values()) {
      const id = session.conversations[key];
      if (id) return id;
    }
    throw new ConversationKeyError(key);
  }

  private buildReverseConvMap(session: AppSessionHandle): void {
    for (const [key, convId] of Object.entries(session.conversations)) {
      this.reverseConvMap.set(convId, key);
    }
  }

  private handleEvent(event: EventFrame): void {
    const data = event.data as Record<string, unknown> | undefined;
    if (!data) return;

    switch (event.event) {
      case EventNames.AppSessionReady:
        this.handleSessionReady(data);
        break;
      case EventNames.AppSessionClosed:
        this.handleSessionClosed(data);
        break;
      case EventNames.AppSkillChallenge:
        this.handleSkillChallenge(data);
        break;
      case EventNames.MessageReceived:
        this.handleMessage(data);
        break;
      case EventNames.AppParticipantAdmitted:
        this.handleParticipantAdmitted(data);
        break;
      case EventNames.AppParticipantRejected:
        this.handleParticipantRejected(data);
        break;
    }
  }

  private handleSessionReady(data: Record<string, unknown>): void {
    const sessionId = data.sessionId as string;
    const conversations = data.conversations as Record<string, string>;

    // Update existing handle or create new one
    let handle = this.sessions.get(sessionId);
    if (handle) {
      // Replace with updated session data
      handle = new AppSessionHandle({
        id: sessionId,
        appId: handle.appId,
        status: "active",
        conversations,
      });
      this.sessions.set(sessionId, handle);
      this.buildReverseConvMap(handle);
    }

    if (handle) {
      this.fireSessionReady(handle);
    }
  }

  private handleSessionClosed(data: Record<string, unknown>): void {
    const sessionId = data.sessionId as string;
    const handle = this.sessions.get(sessionId);
    if (handle) {
      // Remove reverse map entries
      for (const convId of Object.values(handle.conversations)) {
        this.reverseConvMap.delete(convId);
      }
      this.sessions.delete(sessionId);
      this.firedSessionReady.delete(sessionId);
      this.emitError(new SessionClosedError(`Session ${sessionId} was closed`));
    }
  }

  private handleSkillChallenge(data: Record<string, unknown>): void {
    // Auto-respond to skill challenges with the manifest's skillUrl
    const challengeId = data.challengeId as string;
    const skillUrl = this.manifest.skillUrl;

    if (skillUrl) {
      this.client
        .sendRpc("apps/attestSkill", {
          challengeId,
          skillUrl,
          version: this.manifest.skillMinVersion ?? "0.0.0",
        })
        .catch((err) => {
          this.emitError(
            new SessionError(
              "Failed to respond to skill challenge",
              err instanceof Error ? err : undefined,
            ),
          );
        });
    }
  }

  private handleMessage(data: Record<string, unknown>): void {
    const message = data.message as Message;
    if (!message) return;

    const convId = message.conversationId;
    const key = this.reverseConvMap.get(convId);

    // Route to key-specific handler. Use .then() so synchronous throws
    // from the handler land in .catch() rather than escaping to the caller.
    if (key && this.messageHandlers.has(key)) {
      const handler = this.messageHandlers.get(key)!;
      Promise.resolve()
        .then(() => handler(message))
        .catch((err) => {
          this.emitError(
            new AppError(
              "HANDLER_ERROR",
              `Message handler for "${key}" threw`,
              err instanceof Error ? err : undefined,
            ),
          );
        });
    }

    // Route to catch-all handler
    if (this.messageHandlers.has("*")) {
      const handler = this.messageHandlers.get("*")!;
      Promise.resolve()
        .then(() => handler(message))
        .catch((err) => {
          this.emitError(
            new AppError(
              "HANDLER_ERROR",
              "Catch-all message handler threw",
              err instanceof Error ? err : undefined,
            ),
          );
        });
    }
  }

  private handleParticipantAdmitted(data: Record<string, unknown>): void {
    const event = data as unknown as ParticipantAdmittedEvent;
    for (const handler of this.participantAdmittedHandlers) {
      handler(event);
    }
  }

  private handleParticipantRejected(data: Record<string, unknown>): void {
    const event = data as unknown as ParticipantRejectedEvent;
    for (const handler of this.participantRejectedHandlers) {
      handler(event);
    }
  }

  private fireSessionReady(handle: AppSessionHandle): void {
    // Dedup: session can become active via both the apps/create result and
    // a subsequent app/sessionReady event — handlers must only fire once.
    if (this.firedSessionReady.has(handle.id)) return;
    this.firedSessionReady.add(handle.id);

    for (const handler of this.sessionReadyHandlers) {
      Promise.resolve()
        .then(() => handler(handle))
        .catch((err) => {
          this.emitError(
            new AppError(
              "HANDLER_ERROR",
              "Session ready handler threw",
              err instanceof Error ? err : undefined,
            ),
          );
        });
    }
  }

  private handleDisconnect(): void {
    this.heartbeat.stop();
    this.logger.warn("Disconnected from server");
  }

  private handleReconnect(): void {
    this.logger.info("Reconnected to server");

    // Re-check session state after reconnection
    for (const session of this.sessions.values()) {
      this.client
        .sendRpc("apps/getSession", { sessionId: session.id })
        .then((result) => {
          const { session: freshSession } = result as {
            session: AppSession;
          };
          if (
            freshSession.status === "closed" ||
            freshSession.status === "failed"
          ) {
            this.sessions.delete(session.id);
            this.firedSessionReady.delete(session.id);
            for (const convId of Object.values(session.conversations)) {
              this.reverseConvMap.delete(convId);
            }
            this.emitError(
              new SessionClosedError(
                `Session ${session.id} closed during disconnect`,
              ),
            );
          } else {
            // Update session with fresh data
            const updated = new AppSessionHandle(freshSession);
            this.sessions.set(session.id, updated);
            this.buildReverseConvMap(updated);
          }
        })
        .catch((err) => {
          this.emitError(
            new SessionError(
              `Failed to recover session ${session.id} after reconnect`,
              err instanceof Error ? err : undefined,
            ),
          );
        });
    }

    // Restart heartbeat
    this.heartbeat.start(
      () => this.sendPing(),
      this.heartbeatIntervalMs,
      (err) => {
        this.logger.warn("Heartbeat ping failed:", err.message);
        this.client.disconnect();
      },
    );
  }

  private async sendPing(): Promise<void> {
    await this.client.sendRpc("system/ping", {});
  }

  private emitError(error: AppError): void {
    if (this.errorHandler) {
      this.errorHandler(error);
    } else {
      this.logger.error(`[${error.code}] ${error.message}`);
    }
  }
}
