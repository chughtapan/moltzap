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
import { Cause, Data, Duration, Effect, Schema } from "effect";
import { AgentId, UserId } from "@moltzap/protocol/identity";
import type {
  SessionValidation,
  SessionValidator,
} from "./session-validator.js";

/**
 * Raised when the webhook response's `agentId` or `ownerUserId` field
 * fails the TypeBox `format: "uuid"` check on the canonical
 * {@link AgentId} / {@link UserId} schemas. Flows through the same
 * `catchAllCause` fail-closed handler as HTTP / network / timeout /
 * schema-decode errors, so a malformed id collapses to
 * `{ valid: false }` rather than `{ valid: true, agentId: "" as AgentId }`.
 */
class SessionValidationBrandDecodeFailed extends Data.TaggedError(
  "SessionValidationBrandDecodeFailed",
)<{
  readonly field: "agentId" | "ownerUserId";
  readonly cause: unknown;
}> {}

type SessionValidateResponseDecoded =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly agentId: string;
      readonly ownerUserId: string;
      readonly agentStatus?: string;
    };

/**
 * Brand-attach `agentId` and `ownerUserId` via the canonical TypeBox
 * schemas (`format: "uuid"` enforced at decode time). The Effect
 * Schema upstream pins the response SHAPE; this step gives the
 * already-shape-validated id strings their nominal `AgentId` /
 * `UserId` brand at runtime. A malformed id (e.g. "" or
 * "not-a-uuid") yields a typed
 * {@link SessionValidationBrandDecodeFailed} that flows into the
 * `catchAllCause` fail-closed handler in {@link
 * WebhookSessionValidator.validateSession}.
 */
function decodeSessionValidation(
  result: SessionValidateResponseDecoded,
): Effect.Effect<SessionValidation, SessionValidationBrandDecodeFailed> {
  if (result.valid !== true) return Effect.succeed({ valid: false });
  return Effect.try({
    try: () => Schema.decodeUnknownSync(AgentId)(result.agentId),
    catch: (cause) =>
      new SessionValidationBrandDecodeFailed({ field: "agentId", cause }),
  }).pipe(
    Effect.flatMap((agentId) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(UserId)(result.ownerUserId),
        catch: (cause) =>
          new SessionValidationBrandDecodeFailed({
            field: "ownerUserId",
            cause,
          }),
      }).pipe(
        Effect.map((ownerUserId): SessionValidation => {
          const agentStatus = result.agentStatus;
          return agentStatus !== undefined
            ? { valid: true, agentId, ownerUserId, agentStatus }
            : { valid: true, agentId, ownerUserId };
        }),
      ),
    ),
  );
}

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
        Effect.flatMap(decodeSessionValidation),
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
