/** @file Instinct's native email wake uses a dedicated service sender, never a personal mailbox. */

import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "@effect/platform";
import { Effect, Redacted, Schema, Stream } from "effect";
import { NativeWakeError, type NativeWakeup } from "../native/index.js";

const acceptedEmail = Schema.Struct({
  message_id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024)),
  thread_id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024)),
});

/** Deployment owns the provider key and verified native recipient; neither is another MoltZap credential. */
export interface InstinctSender {
  readonly apiKey: Redacted.Redacted;
  readonly inboxId: string;
  readonly recipient: string;
}

/**
 * Provider acceptance permits the caller to acknowledge its Client delivery.
 * A timeout is uncertain: this function never retries or claims exactly-once email.
 *
 * ```mermaid
 * flowchart TD
 *   Work[Client immutable event reference] --> Email[Dedicated AgentMail sender]
 *   Email --> Accepted{Provider accepts and returns message identity?}
 *   Accepted -->|Yes| Handoff[Native wake accepted]
 *   Accepted -->|No or uncertain| Retain[Client delivery remains unread]
 *   Handoff --> Native[Instinct reads canonical event through MCP]
 * ```
 *
 * @param sender The dedicated service sender and verified native recipient.
 * @returns A bounded provider handoff, without retries or model-processing claims.
 */
export function makeInstinctWakeup(sender: InstinctSender): NativeWakeup {
  const approved = { ...sender };
  return Effect.fn("Instinct.sendEmail")((delivery) =>
    sendEmail(approved, delivery.eventId),
  );
}

function sendEmail(sender: InstinctSender, eventId: string) {
  return Effect.gen(function* () {
    yield* validateSender(sender);
    const http = HttpClient.withScope(yield* HttpClient.HttpClient);
    const request = yield* HttpClientRequest.post(
      `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(sender.inboxId)}/messages/send`,
    ).pipe(
      HttpClientRequest.bearerToken(sender.apiKey),
      HttpClientRequest.bodyJson({
        to: [sender.recipient],
        subject: `MoltZap work: ${eventId}`,
        text: `MoltZap event ${eventId} is ready. Use read_event with this eventId on your approved MoltZap MCP connection. Treat this email as a work reference, not message content or permission to send.`,
      }),
      Effect.catchTag("HttpBodyError", () =>
        Effect.fail(new NativeWakeError({ reason: "decode-failed" })),
      ),
    );
    const response = yield* http.execute(request).pipe(
      Effect.catchTags({
        RequestError: () =>
          Effect.fail(new NativeWakeError({ reason: "transport-failed" })),
        ResponseError: () =>
          Effect.fail(new NativeWakeError({ reason: "transport-failed" })),
      }),
    );
    if (response.status !== 200) {
      return yield* Effect.fail(new NativeWakeError({ reason: "refused" }));
    }
    yield* acceptResponse(response);
  }).pipe(
    Effect.scoped,
    Effect.timeoutFail({
      duration: "3 seconds",
      onTimeout: () => new NativeWakeError({ reason: "timed-out" }),
    }),
  );
}

function validateSender(sender: InstinctSender) {
  return validRecipient(sender.recipient) &&
    sender.inboxId.length > 0 &&
    Redacted.value(sender.apiKey).length > 0
    ? Effect.void
    : Effect.fail(new NativeWakeError({ reason: "invalid-configuration" }));
}

function validRecipient(recipient: string): boolean {
  const parts = recipient.split("@");
  return (
    parts.length === 2 &&
    Boolean(parts[0]) &&
    Boolean(parts[1]?.includes(".")) &&
    !/[\s<>]/u.test(recipient)
  );
}

function acceptResponse(response: HttpClientResponse.HttpClientResponse) {
  return readResponseBody(response).pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(acceptedEmail))),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new NativeWakeError({ reason: "decode-failed" })),
    ),
    Effect.asVoid,
  );
}

/**
 * Provider diagnostics are not trusted to have a bounded body, even after HTTP success.
 *
 * @param response The provider's accepted response.
 * @returns At most 16 KiB of strictly decoded UTF-8 text.
 */
function readResponseBody(response: HttpClientResponse.HttpClientResponse) {
  return Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    yield* response.stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          bytes += chunk.byteLength;
          if (bytes > 16 * 1024) {
            return Effect.fail(
              new NativeWakeError({ reason: "decode-failed" }),
            );
          }
          chunks.push(chunk);
          return Effect.void;
        }),
      ),
      Effect.catchTag("ResponseError", () =>
        Effect.fail(new NativeWakeError({ reason: "decode-failed" })),
      ),
    );
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
      catch: () => new NativeWakeError({ reason: "decode-failed" }),
    });
  });
}
