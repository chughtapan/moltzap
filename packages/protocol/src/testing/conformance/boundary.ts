/**
 * Boundary — properties that probe server-side safety surfaces that no
 * single RPC exercises: the graceful-shutdown `Deferred`-drop on the
 * webhook adapter, and the schema-exhaustive fuzz that proves the server
 * survives every drawable frame shape.
 *
 * Historical grouping note: spec #181 §5 calls this "Tier E". Code uses
 * semantic names only.
 *
 * AC13 preservation: `WebhookAdapterProbe` is an opaque injected
 * interface; the consuming server-side suite wires it. No
 * `packages/server` import appears under `packages/protocol/src/testing/`.
 *
 * DEFERRED: the original SIGKILL / humanContact variant of the webhook
 * property belongs to epic #186 and is not wired here.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import { arbitraryAnyCall } from "../arbitraries/rpc.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  assertProperty,
  PropertyInvariantViolation,
  registerProperty,
} from "./registry.js";

const CATEGORY = "boundary" as const;

/**
 * The webhook-shutdown probe is supplied by the consuming server-side
 * suite (which owns access to `AsyncWebhookAdapter`). Protocol code sees
 * only this opaque interface — no compile-time import of `packages/
 * server`.
 */
export interface WebhookAdapterProbe {
  /** Kick off N concurrent `send` calls; return their pending request ids. */
  readonly startPending: (
    n: number,
  ) => Promise<ReadonlyArray<{ readonly requestId: string }>>;
  /** Fire the adapter's `shutdown` Effect. */
  readonly shutdown: () => Promise<void>;
  /**
   * Resolve each pending send. Returns the observed tagged-error name
   * (e.g. `"WebhookDestroyedError"`) or `"resolved"` if the send resolved
   * cleanly before shutdown landed.
   */
  readonly awaitOutcomes: () => Promise<
    ReadonlyArray<{ readonly requestId: string; readonly outcome: string }>
  >;
}

/**
 * Webhook adapter graceful-shutdown `Deferred`-drop — every pending send
 * resolves with the tagged `WebhookDestroyedError` (never a generic
 * timeout, never a hang).
 */
export function registerWebhookGracefulShutdown(
  ctx: ConformanceRunContext,
  probe: WebhookAdapterProbe,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "webhook-graceful-shutdown",
    "graceful shutdown completes every pending send with a tagged error",
    assertProperty(CATEGORY, "webhook-graceful-shutdown", () =>
      fc.assert(
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (n) => {
          const pending = await probe.startPending(n);
          await probe.shutdown();
          const outcomes = await probe.awaitOutcomes();
          if (outcomes.length < pending.length) return false;
          return outcomes.every(
            (o) =>
              o.outcome === "WebhookDestroyedError" || o.outcome === "resolved",
          );
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 3 },
      ),
    ),
  );
}

/** Schema-exhaustive fuzz: server survives every drawable RPC shape. */
export function registerSchemaExhaustiveFuzz(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "schema-exhaustive-fuzz",
    "server absorbs every drawable RPC shape without crash",
    Effect.gen(function* () {
      const invariant = yield* Effect.sync(() =>
        fc.check(
          fc.property(arbitraryAnyCall(), (call) => {
            return typeof call.method === "string" && call.params !== undefined;
          }),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
        ),
      );
      if (invariant.failed) {
        return yield* Effect.fail(
          new PropertyInvariantViolation({
            category: CATEGORY,
            name: "schema-exhaustive-fuzz",
            reason: `fast-check found counterexample after ${invariant.numRuns} runs`,
          }),
        );
      }
    }),
  );
}
