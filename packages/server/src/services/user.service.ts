import type { WebhookClient } from "../adapters/webhook.js";
import type { Logger } from "../logger.js";

export interface UserService {
  validateUser(userId: string): Promise<{ valid: boolean }>;
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
      return await this.client.callSync<{ valid: boolean }>({
        url: this.url,
        event: "users.validate",
        body: { userId },
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      this.logger.error(
        { err, userId, url: this.url },
        "User validation webhook failed, rejecting user",
      );
      return { valid: false };
    }
  }
}
