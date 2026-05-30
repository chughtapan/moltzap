/**
 * Unit tests for the Spec F (#617) `AgentClientConnection` originator's
 * `resolve` path — focused on inbound error-frame decode for codes that
 * match the registered tagged-error registry.
 *
 * The resolver path that constructs the failure value lives in
 * `originator.ts` (the originator helper internalised by `dispatch.ts`
 * post Spec F) and was the site of issue #511: the wire frame's `data`
 * payload was dropped because the registered class was constructed with
 * no arguments.
 *
 * Post Spec F (architect plan #619 §6 FRI), this test exercises the
 * originator through the public typed-dispatcher entry point
 * `makeAgentClientConnection({ handlers: {}, ... })` rather than the
 * legacy `makeOriginator` factory.
 */
import { describe, expect, it } from "vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";

import { defineRpc } from "./method.js";
import { makeAgentClientConnection } from "./connection.js";
import { responseFrame } from "./wire.js";
import { ForbiddenError } from "./wire-errors.js";
import { TaskRejectedError } from "../task/methods.js";

const TestEcho = defineRpc({
  name: "test/echo",
  params: Schema.Struct({}),
  result: Schema.Struct({}),
});

function parseRequestId(raw: string): string {
  const parsed = JSON.parse(raw) as { id?: unknown };
  if (typeof parsed.id !== "string") {
    throw new Error(`expected string id in outgoing frame, got ${raw}`);
  }
  return parsed.id;
}

// Feed an inbound error frame to a fresh client's parked call and return the
// decoded failure value. The call is forked so it parks on the deferred while
// the test feeds the frame via `resolve`. The typed `call` constraint is the
// per-kind outbound catalog; here we exercise the resolver against a synthetic
// descriptor (not in the production catalog), so we widen the call type for
// this test boundary only.
function decodeErrorFrame(
  id: string,
  error: { code: number; message: string; data?: unknown },
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const idDef = yield* Deferred.make<string>();
      const client = yield* makeAgentClientConnection<never, never>({
        id,
        handlers: {},
        write: (raw) =>
          Deferred.succeed(idDef, parseRequestId(raw)).pipe(Effect.ignore),
        idPrefix: "test",
      });
      type CallAny = <D extends typeof TestEcho>(
        d: D,
        p: {},
      ) => ReturnType<typeof client.call>;
      const callFiber = yield* Effect.fork(
        (client.call as CallAny)(TestEcho, {}),
      );
      const outgoingId = yield* Deferred.await(idDef);

      const handled = yield* client.resolve(
        responseFrame(outgoingId, { error }),
      );
      expect(handled).toBe(true);

      const exit = yield* Effect.exit(Fiber.join(callFiber));
      expect(Exit.isFailure(exit)).toBe(true);
      return Exit.isFailure(exit)
        ? Option.getOrNull(Cause.failureOption(exit.cause))
        : null;
    }),
  );
}

describe("AgentClientConnection.resolve — registered tagged-error decode", () => {
  it("preserves the wire frame's `data` payload on a registered error code", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const wireData = { agentIds: ["agent-a", "agent-b"] } as const;
        const value = yield* decodeErrorFrame("test-originator", {
          code: ForbiddenError.code,
          message: "denied",
          data: wireData,
        });
        expect(value).toBeInstanceOf(ForbiddenError);
        expect((value as ForbiddenError).data).toEqual(wireData);
      }),
    ));

  it("preserves the wire frame's `message` on a registered error code", () =>
    // Regression: the resolver reconstructed the registered class with only
    // `data`, so `Data.TaggedError` defaulted `message` to "" and a `catchTag`
    // caller lost the server's error text. Decode must thread `message` through.
    Effect.runPromise(
      Effect.gen(function* () {
        const value = yield* decodeErrorFrame("test-originator-message", {
          code: TaskRejectedError.code,
          message: TaskRejectedError.message,
          data: { taskId: "task-1" },
        });
        expect(value).toBeInstanceOf(TaskRejectedError);
        expect((value as TaskRejectedError).message).toBe(
          TaskRejectedError.message,
        );
        expect((value as TaskRejectedError).message.length).toBeGreaterThan(0);
      }),
    ));
});
