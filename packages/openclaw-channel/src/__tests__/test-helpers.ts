/**
 * Shared test helpers for openclaw-channel integration tests.
 *
 * Agent-only: schema dropped users + contacts (commit de304fa). Helpers now
 * register agents via HTTP only and operate exclusively on agent identifiers
 * exposed by `/api/v1/auth/register`.
 */

import { inject } from "vitest";
import type { Message } from "@moltzap/protocol";
import { Data, Effect } from "effect";
import { postJsonRequest } from "./node-boundary.js";

const WAIT_FOR_POLL_INTERVAL_MS = 50;

type RegisteredAgentClaim = {
  apiKey: string;
  agentId: string;
  claimToken: string;
};

class RegisterAndClaimError extends Data.TaggedError("RegisterAndClaimError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class WaitForTimeoutError extends Error {
  override readonly name = "WaitForTimeoutError";
}

export function registerAndClaim(name: string) {
  const baseUrl = inject("baseUrl");

  return Effect.runPromise(
    Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: (signal) =>
          postJsonRequest(`${baseUrl}/api/v1/auth/register`, { name }, signal),
        catch: (cause) =>
          new RegisterAndClaimError({
            message: `Register ${name} request failed`,
            cause,
          }),
      });
      if (!res.ok) {
        const text = yield* Effect.tryPromise({
          try: () => res.text(),
          catch: (cause) =>
            new RegisterAndClaimError({
              message: `Register ${name} error body read failed`,
              cause,
            }),
        });
        return yield* Effect.fail(
          new RegisterAndClaimError({
            message: `Register ${name} failed: ${res.status} ${text}`,
          }),
        );
      }
      return yield* Effect.tryPromise({
        try: () => res.json() as PromiseLike<RegisteredAgentClaim>,
        catch: (cause) =>
          new RegisterAndClaimError({
            message: `Register ${name} response decode failed`,
            cause,
          }),
      });
    }).pipe(Effect.withSpan("registerAndClaim")),
  );
}

export function extractMessage(event: { params?: unknown }): Message {
  return (event.params as { message: Message }).message;
}

export function extractConvId(result: unknown): string {
  return (result as { conversation: { id: string } }).conversation.id;
}

export function extractText(message: Message): string {
  const part = message.parts[0];
  return part && "text" in part ? part.text : "";
}

export function waitFor(predicate: () => boolean, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new WaitForTimeoutError("waitFor timeout"));
      } else {
        setTimeout(check, WAIT_FOR_POLL_INTERVAL_MS);
      }
    };
    check();
  });
}
