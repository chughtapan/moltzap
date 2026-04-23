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
 * Reaches into server-side state via the `CoreTestServer.coreApp` handle
 * returned by `startCoreTestServer` — NOT by importing
 * `packages/server` at protocol-package typecheck time (AC13). The property
 * accepts a webhook-adapter accessor as a function parameter so the
 * compile-time dependency graph stays one-way.
 *
 * E2 rides on arbitraries/rpc.ts + arbitraries/frames.ts; reuses Tier A's
 * A4 + A5 scaffolding to assert "no crash, no poison, no leak."
 *
 * DEFERRED: the original SIGKILL / humanContact E1 shape is epic #186
 * and is NOT wired here.
 */
import type { ConformanceRunContext } from "./runner.js";

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
  throw new Error("not implemented");
}

/** E2 — schema-exhaustive fuzz survives. */
export function registerE2SchemaFuzz(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}
