import type { WebhookClient } from "../adapters/webhook.js";

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
  ) {}

  async validateUser(userId: string): Promise<{ valid: boolean }> {
    try {
      return await this.client.callSync<{ valid: boolean }>({
        url: this.url,
        event: "users.validate",
        body: { userId },
        timeoutMs: this.timeoutMs,
      });
    } catch (_err) {
      return { valid: false };
    }
  }
}
