/**
 * Unit tests for `JsonRpcClient.resolve` — focused on inbound error-frame
 * decode for codes that match the registered tagged-error registry, and for
 * codes that do not match (unregistered codes → RpcServerError).
 *
 * The resolver path that constructs the failure value lives in
 * `json-rpc-client.ts` and was the site of issue #511 (the wire frame's
 * `data` payload was dropped because the registered class was constructed
 * with no arguments).
 */
import { describe, expect, it } from "vitest";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { Type } from "@sinclair/typebox";

import { defineRpc } from "./method.js";
import { makeJsonRpcClient } from "./json-rpc-client.js";
import { responseFrame, type ResponseFrame } from "./wire.js";
import { ForbiddenError } from "./wire-errors.js";
import { RpcServerError } from "./rpc-errors.js";

const TestEcho = defineRpc({
  name: "test/echo",
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
});

function parseRequestId(raw: string): string {
  const parsed = JSON.parse(raw) as { id?: unknown };
  if (typeof parsed.id !== "string") {
    throw new Error(`expected string id in outgoing frame, got ${raw}`);
  }
  return parsed.id;
}

/** An error code not registered in the wire-error registry. */
const UNREGISTERED_CODE = 9999;

describe("JsonRpcClient.resolve — unregistered error code → RpcServerError", () => {
  it("wraps an unregistered error code as RpcServerError with code, message, and data threaded through", async () => {
    const wireData = { detail: "some-extra-info" } as const;

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const idDef = yield* Deferred.make<string>();
          const client = yield* makeJsonRpcClient({
            write: (raw) =>
              Deferred.succeed(idDef, parseRequestId(raw)).pipe(Effect.ignore),
            idPrefix: "test",
          });

          const callFiber = yield* Effect.fork(client.call(TestEcho, {}));
          const outgoingId = yield* Deferred.await(idDef);

          const inbound: ResponseFrame = responseFrame(outgoingId, {
            error: {
              code: UNREGISTERED_CODE,
              message: "unknown server failure",
              data: wireData,
            },
          });

          const handled = yield* client.resolve(inbound);
          expect(handled).toBe(true);

          return yield* Effect.exit(Fiber.join(callFiber));
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag !== "Some") return;
    const value = failure.value;
    // The branch under test: cls === undefined → RpcServerError, not a
    // registered tagged-error class. If this branch broke (e.g., cls were
    // mistakenly defined for this code), the assertion below would fail
    // because a registered error instance is NOT an instanceof RpcServerError.
    expect(value).toBeInstanceOf(RpcServerError);
    expect((value as RpcServerError).code).toBe(UNREGISTERED_CODE);
    expect((value as RpcServerError).message).toBe("unknown server failure");
    expect((value as RpcServerError).data).toEqual(wireData);
  });
});

describe("JsonRpcClient.resolve — registered tagged-error decode", () => {
  it("preserves the wire frame's `data` payload on a registered error code", async () => {
    const wireData = { agentIds: ["agent-a", "agent-b"] } as const;

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Capture the request id the client mints on the first write.
          // Effect.ignore makes a second write (none expected) a no-op.
          const idDef = yield* Deferred.make<string>();
          const client = yield* makeJsonRpcClient({
            write: (raw) =>
              Deferred.succeed(idDef, parseRequestId(raw)).pipe(Effect.ignore),
            idPrefix: "test",
          });

          // Issue the call on a fiber so it parks on the deferred while
          // the test feeds an inbound error frame via `resolve`.
          const callFiber = yield* Effect.fork(client.call(TestEcho, {}));
          const outgoingId = yield* Deferred.await(idDef);

          const inbound: ResponseFrame = responseFrame(outgoingId, {
            error: {
              code: ForbiddenError.code,
              message: "denied",
              data: wireData,
            },
          });

          const handled = yield* client.resolve(inbound);
          expect(handled).toBe(true);

          return yield* Effect.exit(Fiber.join(callFiber));
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag !== "Some") return;
    const value = failure.value;
    expect(value).toBeInstanceOf(ForbiddenError);
    // Regression guard for #511: the wire `data` payload reaches the
    // typed instance instead of arriving as `undefined`.
    expect((value as ForbiddenError).data).toEqual(wireData);
  });
});
