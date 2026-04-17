import { Effect } from "effect";
import type { WebhookClient } from "../adapters/webhook.js";
import type { Logger } from "../logger.js";

export interface UserService {
  validateUser(userId: string): Effect.Effect<{ valid: boolean }, never>;
}

export class InProcessUserService implements UserService {
  validateUser(_userId: string): Effect.Effect<{ valid: boolean }, never> {
    return Effect.succeed({ valid: true });
  }
}

export class WebhookUserService implements UserService {
  constructor(
    private client: WebhookClient,
    private url: string,
    private timeoutMs: number,
    private logger: Logger,
  ) {}

  validateUser(userId: string): Effect.Effect<{ valid: boolean }, never> {
    return Effect.tryPromise({
      try: () =>
        this.client.callSync<{ valid: boolean }>({
          url: this.url,
          event: "users.validate",
          body: { userId },
          timeoutMs: this.timeoutMs,
        }),
      catch: (err) => err,
    }).pipe(
      // Strict boolean check — don't trust truthy strings from external services
      Effect.map((result) => ({ valid: result.valid === true })),
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          this.logger.error(
            { err: cause, userId, url: this.url },
            "User validation webhook failed, rejecting user",
          );
          return { valid: false };
        }),
      ),
    );
  }
}
