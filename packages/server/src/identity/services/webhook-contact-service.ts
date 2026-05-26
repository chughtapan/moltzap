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
 * `app/layers.ts`; tests override it via `Layer.succeed(HttpClient.HttpClient, mock)`.
 */

import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { Duration, Effect, Schema } from "effect";
import type { ContactService } from "./contact-policy.js";

const ContactsCheckResponse = Schema.Struct({ inContact: Schema.Boolean });
const EVENT_NAME = "contacts.check";

export class WebhookContactService implements ContactService {
  constructor(
    private readonly httpClient: HttpClient.HttpClient,
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  areInContact(
    userIdA: string,
    userIdB: string,
  ): Effect.Effect<boolean, never> {
    return this.httpClient
      .execute(
        HttpClientRequest.post(this.url).pipe(
          HttpClientRequest.setHeader("X-MoltZap-Event", EVENT_NAME),
          HttpClientRequest.bodyUnsafeJson({ userIdA, userIdB }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(ContactsCheckResponse),
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
