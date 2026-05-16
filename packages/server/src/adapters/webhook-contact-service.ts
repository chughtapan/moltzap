/** Webhook-backed contact service adapter. */

import { Effect, Schema } from "effect";
import type { ContactService } from "../app/app-host.js";
import type { Logger } from "../logger.js";
import type { WebhookClient } from "./webhook.js";

const ContactsCheckResponse = Schema.Struct({ inContact: Schema.Boolean });

export class WebhookContactService implements ContactService {
  constructor(
    private client: WebhookClient,
    private url: string,
    private timeoutMs: number,
    private webhookLogger: Logger,
  ) {}

  areInContact(
    userIdA: string,
    userIdB: string,
  ): Effect.Effect<boolean, never> {
    return this.client
      .call({
        url: this.url,
        event: "contacts.check",
        body: { userIdA, userIdB },
        timeoutMs: this.timeoutMs,
        schema: ContactsCheckResponse,
      })
      .pipe(
        Effect.map((result) => result.inContact),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            this.webhookLogger.error(
              { err, userIdA, userIdB, url: this.url },
              "Contact check webhook failed, rejecting contact",
            );
            return false;
          }),
        ),
      );
  }
}
