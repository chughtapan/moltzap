/** @file Router acquisition evidence preserves interruption and causal order. */

import { assert, effect as test } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import { RouterEvents } from "../events/core.js";
import type { LedgerWriter } from "../ledger/live.js";
import { LedgerStorageError } from "../ledger/storage.js";
import { RouterProvider, networkFailure } from "../network/router.js";
import { acquireRouter } from "./router.js";

type RouterEventWriter = LedgerWriter<typeof RouterEvents>;
const neverWriter: RouterEventWriter = {
  write: () =>
    Effect.dieMessage(
      "interrupted acquisition must not write failure evidence",
    ),
};

test("does not record an interrupted router acquisition as a start failure", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.scoped(acquireRouter(neverWriter)).pipe(
      Effect.provideService(RouterProvider, {
        acquire: Effect.never,
      }),
      Effect.fork,
    );
    yield* Effect.yieldNow();

    const exit = yield* Fiber.interrupt(fiber);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.isInterruptedOnly(exit.cause));
    }
  }));

test("keeps router and evidence-write failures in causal order", () =>
  Effect.gen(function* () {
    const writer: RouterEventWriter = {
      write: () =>
        Effect.fail(
          LedgerStorageError.make({
            operation: "append",
            detail: "ledger unavailable",
          }),
        ),
    };
    const exit = yield* Effect.exit(
      Effect.scoped(acquireRouter(writer)).pipe(
        Effect.provideService(RouterProvider, {
          acquire: Effect.fail(
            networkFailure("acquire-router", "router unavailable"),
          ),
        }),
      ),
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const rendered = Cause.pretty(exit.cause);
      assert.include(rendered, "router unavailable");
      assert.include(rendered, "ledger unavailable");
    }
  }));
