/** Webhook-backed session validator adapter. */

import { Cause, Effect, Schema } from "effect";
import type { WebhookClient } from "./webhook.js";
import type { AgentId, UserId } from "../app/types.js";
import type {
  SessionValidation,
  SessionValidator,
} from "../identity/services/session-validator.js";

const SessionValidateResponse = Schema.Union(
  Schema.Struct({
    valid: Schema.Literal(true),
    agentId: Schema.String,
    ownerUserId: Schema.String,
    agentStatus: Schema.optional(Schema.String),
  }),
  Schema.Struct({ valid: Schema.Literal(false) }),
);

export class WebhookSessionValidator implements SessionValidator {
  constructor(
    private client: WebhookClient,
    private url: string,
    private timeoutMs: number,
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
          this.logCauseAsFailClosed(cause, { url: this.url }).pipe(
            Effect.as({ valid: false } satisfies SessionValidation),
          ),
        ),
      );
  }

  private logCauseAsFailClosed(
    cause: Cause.Cause<unknown>,
    ctx: Record<string, unknown>,
  ): Effect.Effect<void> {
    const label = "Session validation webhook";
    const annotations = { cause: Cause.pretty(cause), ...ctx };
    if (Cause.dieOption(cause)._tag === "Some") {
      return Effect.logError(`${label} defect (bug) - rejecting`).pipe(
        Effect.annotateLogs(annotations),
      );
    }
    return Effect.logWarning(`${label} failed - rejecting`).pipe(
      Effect.annotateLogs(annotations),
    );
  }
}
