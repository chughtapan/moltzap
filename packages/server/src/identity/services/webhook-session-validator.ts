/**
 * Webhook-backed {@link SessionValidator}.
 *
 * POSTs `{ token }` to the configured URL with a `timeoutMs` budget,
 * decodes either a `{ valid: true, agentId, ownerUserId, agentStatus? }`
 * or `{ valid: false }` response, and fail-closes (`{ valid: false }`)
 * on any HTTP / network / timeout / decode error. Defects are logged at
 * `error`; expected failures at `warning`. Wired in
 * `standalone.ts → makeSessionValidator` when
 * `services.sessions: { type: "webhook" }` appears in the YAML config.
 *
 * The transport is the `@effect/platform/HttpClient` Tag from
 * `app/layers.ts`; tests override it via `Layer.succeed(HttpClient.HttpClient, mock)`.
 */

import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { Cause, Duration, Effect, Schema } from "effect";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type {
  SessionValidation,
  SessionValidator,
} from "./session-validator.js";

const SessionValidateResponse = Schema.Union(
  Schema.Struct({
    valid: Schema.Literal(true),
    agentId: Schema.String,
    ownerUserId: Schema.String,
    agentStatus: Schema.optional(Schema.String),
  }),
  Schema.Struct({ valid: Schema.Literal(false) }),
);

const EVENT_NAME = "sessions.validate";

export class WebhookSessionValidator implements SessionValidator {
  constructor(
    private readonly httpClient: HttpClient.HttpClient,
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  validateSession(token: string): Effect.Effect<SessionValidation, never> {
    return this.httpClient
      .execute(
        HttpClientRequest.post(this.url).pipe(
          HttpClientRequest.setHeader("X-MoltZap-Event", EVENT_NAME),
          HttpClientRequest.bodyUnsafeJson({ token }),
        ),
      )
      .pipe(
        // Drain the response body unconditionally before `filterStatusOk`.
        // `response.text` is `Effect.cached`, so the subsequent
        // `schemaBodyJson` reuses the same buffer on 2xx without
        // re-reading the socket; on non-2xx, this prevents the body
        // from being left for the FinalizationRegistry to reap.
        Effect.tap((response) => response.text),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(SessionValidateResponse),
        ),
        Effect.timeout(Duration.millis(this.timeoutMs)),
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
