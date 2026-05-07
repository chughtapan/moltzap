import { Cause, Effect, Schema } from "effect";
import type { WebhookClient } from "../adapters/webhook.js";
import type { Logger } from "../logger.js";
import type { AgentId, UserId } from "../app/types.js";

const SessionValidateResponse = Schema.Union(
  Schema.Struct({
    valid: Schema.Literal(true),
    agentId: Schema.String,
    ownerUserId: Schema.String,
    agentStatus: Schema.optional(Schema.String),
  }),
  Schema.Struct({ valid: Schema.Literal(false) }),
);

/**
 * Result of resolving an app-minted bearer session token. Discriminated
 * union: `valid: true` guarantees `agentId` and `ownerUserId`; `valid:
 * false` carries no payload. `agentStatus` is optional — when present the
 * `network/connect` handler skips a follow-up `SELECT status FROM agents`.
 */
export type SessionValidation =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly agentId: AgentId;
      readonly ownerUserId: UserId;
      readonly agentStatus?: string;
    };

export interface SessionValidator {
  validateSession(token: string): Effect.Effect<SessionValidation, never>;
}

export class WebhookSessionValidator implements SessionValidator {
  constructor(
    private client: WebhookClient,
    private url: string,
    private timeoutMs: number,
    private logger: Logger,
  ) {}

  validateSession(token: string): Effect.Effect<SessionValidation, never> {
    return this.client
      .call({
        url: this.url,
        event: "sessions.validate",
        body: { token },
        timeoutMs: this.timeoutMs,
        schema: SessionValidateResponse,
      })
      .pipe(
        Effect.map((result): SessionValidation => {
          if (result.valid !== true) return { valid: false };
          const agentStatus = result.agentStatus;
          const agentId = result.agentId as AgentId;
          const ownerUserId = result.ownerUserId as UserId;
          return agentStatus !== undefined
            ? { valid: true, agentId, ownerUserId, agentStatus }
            : { valid: true, agentId, ownerUserId };
        }),
        Effect.catchAllCause((cause) =>
          Effect.sync((): SessionValidation => {
            this.logCauseAsFailClosed(cause, {
              url: this.url,
            });
            return { valid: false };
          }),
        ),
      );
  }

  /**
   * Fail-closed reject logging. Expected failures (`Cause.Fail` —
   * `WebhookError` variants) log at warn. Defects (`Cause.Die` — bugs)
   * log at error with the full pretty cause.
   */
  private logCauseAsFailClosed(
    cause: Cause.Cause<unknown>,
    ctx: Record<string, unknown>,
  ): void {
    const label = "Session validation webhook";
    if (Cause.dieOption(cause)._tag === "Some") {
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
