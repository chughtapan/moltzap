/** @file Router acquisition evidence preserves interruption and causal order. */

import { assert, effect as test } from "@effect/vitest";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import { Cause, Effect, Exit, Fiber, Option, Ref, Schema } from "effect";
import type { routerEvents } from "../events/core.js";
import type { LedgerWriter } from "../ledger/append.js";
import { LedgerStorageError } from "../ledger/storage.js";
import {
  makeRouterStopReport,
  type Router,
  RouterProvider,
} from "../network/router.js";
import { networkError } from "../network/failure.js";
import { acquireRouter } from "./router.js";

type RouterEventWriter = LedgerWriter<typeof routerEvents>;
const ROUTER_URL = Schema.decodeSync(serverBaseUrlSchema)(
  "http://127.0.0.1:43100",
);
const neverWriter: RouterEventWriter = {
  write: () =>
    Effect.dieMessage(
      "interrupted acquisition must not write failure evidence",
    ),
};

test("does not record an interrupted router acquisition as a start failure", () =>
  Effect.gen(function* () {
    const routerRef = yield* Ref.make(Option.none<Router>());
    const fiber = yield* Effect.scoped(
      acquireRouter(neverWriter, routerRef),
    ).pipe(
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
    const routerRef = yield* Ref.make(Option.none<Router>());
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
      Effect.scoped(acquireRouter(writer, routerRef)).pipe(
        Effect.provideService(RouterProvider, {
          acquire: Effect.fail(
            networkError("acquire-router", "router unavailable"),
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

test("publishes router ownership before the started-event append", () =>
  Effect.gen(function* () {
    const router: Router = {
      address: ROUTER_URL,
      stopped: Effect.succeed(makeRouterStopReport([])),
      attachAgent: () => Effect.dieMessage("unused"),
      attachEndpoint: () => Effect.dieMessage("unused"),
    };
    const routerRef = yield* Ref.make(Option.none<Router>());
    const writer: RouterEventWriter = {
      write: () =>
        Effect.fail(
          LedgerStorageError.make({
            operation: "append",
            detail: "router-start record rejected",
          }),
        ),
    };

    const exit = yield* Effect.exit(
      Effect.scoped(acquireRouter(writer, routerRef)).pipe(
        Effect.provideService(RouterProvider, {
          acquire: Effect.succeed(router),
        }),
      ),
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual(yield* Ref.get(routerRef), Option.some(router));
  }));
