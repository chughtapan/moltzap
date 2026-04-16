import type { WebhookClient } from "../adapters/webhook.js";
import type { Logger } from "../logger.js";

export interface SessionValidation {
  valid: boolean;
  agentId?: string;
  ownerUserId?: string;
}

export interface UserService {
  /** Validate a userId is known + active. Used during app-session gating. */
  validateUser(userId: string): Promise<{ valid: boolean }>;
  /**
   * Validate an app-minted session token during auth/connect. Optional —
   * cores that don't support bearer-token auth omit it. Resolvers return
   * `{valid: false}` for unknown/expired/revoked tokens; `{valid: true,
   * agentId, ownerUserId}` on success.
   */
  validateSession?(token: string): Promise<SessionValidation>;
}

export class InProcessUserService implements UserService {
  async validateUser(_userId: string): Promise<{ valid: boolean }> {
    return { valid: true };
  }
}

export class WebhookUserService implements UserService {
  constructor(
    private client: WebhookClient,
    private url: string,
    private timeoutMs: number,
    private logger: Logger,
  ) {}

  async validateUser(userId: string): Promise<{ valid: boolean }> {
    try {
      const result = await this.client.callSync<{ valid: boolean }>({
        url: this.url,
        event: "users.validate",
        body: { userId },
        timeoutMs: this.timeoutMs,
      });
      // Strict boolean check — don't trust truthy strings from external services
      return { valid: result.valid === true };
    } catch (err) {
      this.logger.error(
        { err, userId, url: this.url },
        "User validation webhook failed, rejecting user",
      );
      return { valid: false };
    }
  }

  async validateSession(token: string): Promise<SessionValidation> {
    try {
      const result = await this.client.callSync<SessionValidation>({
        url: this.url,
        event: "sessions.validate",
        body: { token },
        timeoutMs: this.timeoutMs,
      });
      if (result.valid !== true) return { valid: false };
      if (!result.agentId || !result.ownerUserId) return { valid: false };
      return {
        valid: true,
        agentId: result.agentId,
        ownerUserId: result.ownerUserId,
      };
    } catch (err) {
      this.logger.error(
        { err, url: this.url },
        "Session validation webhook failed, rejecting",
      );
      return { valid: false };
    }
  }
}
