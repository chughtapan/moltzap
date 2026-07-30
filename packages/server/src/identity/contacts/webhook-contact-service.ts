/**
 * Webhook-backed {@link ContactService}.
 *
 * POSTs `{ userIdA, userIdB }` to the configured URL with a `timeoutMs`
 * budget, decodes `{ inContact: boolean }` from the response, and
 * fail-closes (`false`) on any HTTP / network / timeout / decode error.
 * Wired in `standalone.ts → installContactService` when
 * `services.contacts: { type: "webhook" }` appears in the YAML config.
 *
 * The transport is the `@effect/platform/HttpClient` Tag from
 * `core/layers.ts`; tests override it via `Layer.succeed(HttpClient.HttpClient, mock)`.
 */

import {
  type HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { Duration, Effect, Schema } from "effect";
import type { ContactService } from "./contact-policy.js";
import type { UserId } from "@moltzap/protocol/identity";

const contactsCheckResponse = Schema.Struct({ inContact: Schema.Boolean });
const EVENT_NAME = "contacts.check";

/** Implements webhook contact service. */
export class WebhookContactService implements ContactService {
  private readonly httpClient: HttpClient.HttpClient;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(
    httpClient: HttpClient.HttpClient,
    url: string,
    timeoutMs: number,
  ) {
    this.httpClient = httpClient;
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  areInContact(userIdA: UserId, userIdB: UserId): Effect.Effect<boolean> {
    return this.httpClient
      .execute(
        HttpClientRequest.post(this.url).pipe(
          HttpClientRequest.setHeader("X-MoltZap-Event", EVENT_NAME),
          HttpClientRequest.bodyUnsafeJson({ userIdA, userIdB }),
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
          HttpClientResponse.schemaBodyJson(contactsCheckResponse),
        ),
        Effect.timeout(Duration.millis(this.timeoutMs)),
        Effect.map((result) => result.inContact),
        Effect.catchAll((err) =>
          Effect.logError(
            "Contact check webhook failed, rejecting contact",
          ).pipe(
            Effect.annotateLogs({ err, userIdA, userIdB, url: this.url }),
            Effect.as(false),
          ),
        ),
      );
  }
}
