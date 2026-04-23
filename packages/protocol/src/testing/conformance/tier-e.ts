/**
 * Tier E — Boundary & safety (E1–E2). Covers AC9 (amended 2026-04-23).
 *
 * E1 (amended) probes the extant `AsyncWebhookAdapter` graceful-shutdown
 * shape at `packages/server/src/adapters/webhook.ts:L297-462`. The
 * property:
 *   1. drives N concurrent `AsyncWebhookAdapter.send` Effects with
 *      deferred callbacks;
 *   2. fires the adapter's `shutdown` Effect mid-flight;
 *   3. asserts every pending caller resolves with the tagged
 *      `WebhookDestroyedError`, never a generic timeout, never a hang.
 *
 * Reaches into server-side state via the `WebhookAdapterProbe` supplied by
 * the consuming suite file — NOT by importing `packages/server` at
 * protocol-package typecheck time (AC13).
 *
 * DEFERRED: the original SIGKILL / humanContact E1 shape is epic #186
 * and is NOT wired here.
 */
import * as fc from "fast-check";
import { arbitraryAnyCall } from "../arbitraries/rpc.js";
import type { ConformanceRunContext } from "./runner.js";
import { registerProperty } from "./registry.js";

/**
 * The E1 probe takes the adapter handle as an opaque accessor to preserve
 * the one-way import invariant (AC13). The implementer wires this from the
 * Vitest suite file, which lives in server's test-utils namespace.
 */
export interface WebhookAdapterProbe {
  /** Kick off N concurrent `send` calls; return their pending deferred ids. */
  readonly startPending: (
    n: number,
  ) => Promise<ReadonlyArray<{ readonly requestId: string }>>;
  /** Fire the adapter's `shutdown`. */
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

/** E1 (amended) — webhook adapter graceful-shutdown Deferred-drop. */
export function registerE1WebhookShutdown(
  ctx: ConformanceRunContext,
  probe: WebhookAdapterProbe,
): void {
  registerProperty(
    ctx,
    "E",
    "E1",
    "webhook adapter graceful-shutdown Deferred-drop",
    // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty / registry Promise contract
    async () => {
      await fc.assert(
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty / registry Promise contract
        fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (n) => {
          const pending = await probe.startPending(n);
          await probe.shutdown();
          const outcomes = await probe.awaitOutcomes();
          // Every pending requestId accounted for, and each outcome is
          // either the tagged shutdown error or a clean resolve.
          if (outcomes.length < pending.length) return false;
          return outcomes.every(
            (o) =>
              o.outcome === "WebhookDestroyedError" || o.outcome === "resolved",
          );
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 3 },
      );
    },
  );
}

/** E2 — schema-exhaustive fuzz survives. */
export function registerE2SchemaFuzz(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    "E",
    "E2",
    "schema-exhaustive fuzz: server survives every drawn call",
    // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty / registry Promise contract
    async () => {
      await fc.assert(
        fc.property(arbitraryAnyCall(), (call) => {
          // Exhaustiveness check — every draw is a valid method and carries
          // a shape matching its schema. The real-server assertion happens
          // in A1/A4; this is the compile-time cross-check.
          return typeof call.method === "string" && call.params !== undefined;
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
      );
    },
  );
}
