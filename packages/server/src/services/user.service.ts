import { Cause, Effect } from "effect";
import type { WebhookClient } from "../adapters/webhook.js";
import type { Logger } from "../logger.js";
import { AgentId, UserId } from "../app/types.js";

/**
 * Result of resolving an app-minted bearer session token. Discriminated
 * union: `valid: true` guarantees `agentId` and `ownerUserId` are present,
 * `valid: false` carries no payload. Narrow on `.valid` at call sites.
 *
 * The wire shape from webhooks is looser (optional fields); the
 * `WebhookUserService` normalizer rejects partial payloads so anything
 * reaching a call site already satisfies this invariant.
 *
 * `agentStatus` is optional: when the webhook returns it we skip the
 * `auth/connect` follow-up DB query that gates `requiresActive`. When
 * absent, the handler falls back to a single `SELECT status FROM agents`
 * (one extra round trip per bearer-token auth).
 */
export type SessionValidation =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly agentId: AgentId;
      readonly ownerUserId: UserId;
      readonly agentStatus?: string;
    };

export interface UserService {
  validateUser(userId: UserId): Effect.Effect<{ valid: boolean }, never>;
  /**
   * Validate an app-minted session token during auth/connect. Optional —
   * cores that don't support bearer-token auth omit it entirely. Returns
   * `{valid: false}` for unknown/expired/revoked tokens.
   */
  validateSession?(token: string): Effect.Effect<SessionValidation, never>;
}

export class InProcessUserService implements UserService {
  validateUser(_userId: UserId): Effect.Effect<{ valid: boolean }, never> {
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

  validateUser(userId: UserId): Effect.Effect<{ valid: boolean }, never> {
    return this.client
      .call<{ valid: boolean }>({
        url: this.url,
        event: "users.validate",
        body: { userId },
        timeoutMs: this.timeoutMs,
      })
      .pipe(
        // Strict boolean check — don't trust truthy strings from external services
        Effect.map((result) => ({ valid: result.valid === true })),
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            this.logCauseAsFailClosed(cause, "User validation webhook", {
              userId,
              url: this.url,
            });
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
      /** Optional: lets `auth/connect` skip a DB round trip when the
       * webhook already knows the agent's status. */
      agentStatus?: unknown;
    }
    return this.client
      .call<WireResponse>({
        url: this.url,
        event: "sessions.validate",
        body: { token },
        timeoutMs: this.timeoutMs,
      })
      .pipe(
        Effect.map((result): SessionValidation => {
          if (result.valid !== true) return { valid: false };
          if (
            typeof result.agentId !== "string" ||
            typeof result.ownerUserId !== "string"
          ) {
            return { valid: false };
          }
          const agentStatus =
            typeof result.agentStatus === "string"
              ? result.agentStatus
              : undefined;
          const agentId = AgentId(result.agentId);
          const ownerUserId = UserId(result.ownerUserId);
          return agentStatus !== undefined
            ? { valid: true, agentId, ownerUserId, agentStatus }
            : { valid: true, agentId, ownerUserId };
        }),
        Effect.catchAllCause((cause) =>
          Effect.sync((): SessionValidation => {
            this.logCauseAsFailClosed(cause, "Session validation webhook", {
              url: this.url,
            });
            return { valid: false };
          }),
        ),
      );
  }

  /**
   * Fail-closed reject logging. Expected failures (`Cause.Fail` — the
   * tagged `WebhookError` variants raised by `WebhookClient.call`) log
   * at warn. Defects (`Cause.Die` — synchronous throws inside the
   * pipeline, always bugs) log at error with the full pretty cause so
   * they're visible in the normal error stream, not hidden behind a
   * quiet auth rejection.
   */
  private logCauseAsFailClosed(
    cause: Cause.Cause<unknown>,
    label: string,
    ctx: Record<string, unknown>,
  ): void {
    if (Cause.isDieType(cause) || Cause.dieOption(cause)._tag === "Some") {
      this.logger.error(
        { cause: Cause.pretty(cause), ...ctx },
        `${label} defect (bug) — rejecting`,
      );
    } else {
      this.logger.warn(
        { cause: Cause.pretty(cause), ...ctx },
        `${label} failed — rejecting`,
      );
    }
  }
}
