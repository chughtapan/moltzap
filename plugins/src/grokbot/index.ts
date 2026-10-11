/** @file Grok Bot wakes only through the owner's captured native routine connection. */

import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Redacted } from "effect";
import { NativeWakeError, type NativeWakeup } from "../native/index.js";

/** The existing native UI supplies this exact URL and key; deployment retains owner-approved custody. */
export interface GrokRoutine {
  readonly url: URL;
  readonly key: Redacted.Redacted;
}

/**
 * The routine receives a work reference, not synthetic message content or a reply gateway.
 * HTTP acceptance proves handoff only. Uncertain delivery is not retried here.
 *
 * ```mermaid
 * flowchart TD
 *   Work[Client immutable event reference] --> Routine[Owner-approved native routine]
 *   Routine --> Accepted{Native HTTP acceptance?}
 *   Accepted -->|Yes| Handoff[Wake accepted]
 *   Accepted -->|No or uncertain| Retain[Client delivery remains unread]
 *   Handoff --> Native[Grok reads canonical event through MCP]
 * ```
 *
 * @param routine The owner's approved routine connection.
 * @returns A bounded provider handoff, without retries or model-processing claims.
 */
export function makeGrokWakeup(routine: GrokRoutine): NativeWakeup {
  const approved = { url: new URL(routine.url.href), key: routine.key };
  return Effect.fn("Grok.invokeRoutine")((delivery) =>
    invokeRoutine(approved, delivery.eventId),
  );
}

function invokeRoutine(routine: GrokRoutine, eventId: string) {
  return Effect.gen(function* () {
    if (
      !validRoutineUrl(routine.url) ||
      Redacted.value(routine.key).length === 0
    ) {
      return yield* Effect.fail(
        new NativeWakeError({ reason: "invalid-configuration" }),
      );
    }
    const http = HttpClient.withScope(yield* HttpClient.HttpClient);
    const request = yield* HttpClientRequest.post(routine.url).pipe(
      HttpClientRequest.bearerToken(routine.key),
      HttpClientRequest.bodyJson({
        eventId,
        instruction:
          "Read this eventId with read_event on your approved MoltZap MCP connection. This routine is a wake signal, not message content or permission to send.",
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
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(new NativeWakeError({ reason: "refused" }));
    }
  }).pipe(
    Effect.scoped,
    Effect.timeoutFail({
      duration: "3 seconds",
      onTimeout: () => new NativeWakeError({ reason: "timed-out" }),
    }),
  );
}

function validRoutineUrl(url: URL): boolean {
  if (url.protocol !== "https:") {
    return false;
  }
  return !url.username && !url.password && !url.hash;
}
