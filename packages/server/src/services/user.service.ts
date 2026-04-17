import { Effect } from "effect";
import type { WebhookClient } from "../adapters/webhook.js";
import type { Logger } from "../logger.js";

/**
 * Result of resolving an app-minted bearer session token. Discriminated
 * union: `valid: true` guarantees `agentId` and `ownerUserId` are present,
 * `valid: false` carries no payload. Narrow on `.valid` at call sites.
 *
 * The wire shape from webhooks is looser (optional fields); the
 * `WebhookUserService` normalizer rejects partial payloads so anything
 * reaching a call site already satisfies this invariant.
 */
export type SessionValidation =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly agentId: string;
      readonly ownerUserId: string;
    };

export interface UserService {
  validateUser(userId: string): Effect.Effect<{ valid: boolean }, never>;
  /**
   * Validate an app-minted session token during auth/connect. Optional —
   * cores that don't support bearer-token auth omit it entirely. Returns
   * `{valid: false}` for unknown/expired/revoked tokens.
   */
  validateSession?(token: string): Effect.Effect<SessionValidation, never>;
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

  validateSession(token: string): Effect.Effect<SessionValidation, never> {
    // Wire shape is looser than the internal discriminated union; normalize
    // here so nothing downstream needs to re-check for missing fields.
    interface WireResponse {
      valid?: unknown;
      agentId?: unknown;
      ownerUserId?: unknown;
    }
    return Effect.tryPromise({
      try: () =>
        this.client.callSync<WireResponse>({
          url: this.url,
          event: "sessions.validate",
          body: { token },
          timeoutMs: this.timeoutMs,
        }),
      catch: (err) => err,
    }).pipe(
      Effect.map((result): SessionValidation => {
        if (result.valid !== true) return { valid: false };
        if (
          typeof result.agentId !== "string" ||
          typeof result.ownerUserId !== "string"
        ) {
          return { valid: false };
        }
        return {
          valid: true,
          agentId: result.agentId,
          ownerUserId: result.ownerUserId,
        };
      }),
      Effect.catchAllCause((cause) =>
        Effect.sync((): SessionValidation => {
          this.logger.error(
            { err: cause, url: this.url },
            "Session validation webhook failed, rejecting",
          );
          return { valid: false };
        }),
      ),
    );
  }
}
