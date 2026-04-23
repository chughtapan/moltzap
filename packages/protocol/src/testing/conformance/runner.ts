/**
 * Conformance-suite runner.
 *
 * Orchestrates tiers A → E under one Vitest entrypoint so
 * `pnpm -F @moltzap/protocol test:conformance` is the only command a CI
 * job needs (AC11).
 *
 * Responsibilities:
 *   - stand up a real MoltZap server via `startCoreTestServer`
 *     (server/test-utils — consumed, not re-homed);
 *   - stand up Toxiproxy via docker-compose (Tier D only);
 *   - pin fast-check seeds and export them on failure (AC10);
 *   - tear everything down in reverse order.
 */
import type { Effect, Scope } from "effect";
import type { ToxiproxyClient } from "../toxics/client.js";

/**
 * Opaque handle to a running real MoltZap server. The conformance runner
 * accepts this as an injected dependency so the protocol package has no
 * compile-time import of `packages/server` (AC13). The consuming suite
 * file supplies a concrete value built from `startCoreTestServer` — see
 * design doc §10.
 */
export interface RealServerHandle {
  readonly wsUrl: string;
  readonly baseUrl: string;
  /** Teardown hook; the runner's Scope calls this on release. */
  readonly close: () => Promise<void>;
}

export interface ConformanceRunOptions {
  readonly tiers: ReadonlyArray<"A" | "B" | "C" | "D" | "E">;
  /** If provided, replay this exact fast-check seed (AC10 reproducibility). */
  readonly replaySeed?: number;
  /** Number of runs per property; fast-check default is 100. */
  readonly numRuns?: number;
  /** When `true`, bring up docker-compose Toxiproxy; else assume running. */
  readonly manageToxiproxy?: boolean;
  /** Output directory for seed + toxic-config dump on failure. */
  readonly artifactDir?: string;
}

export interface ConformanceRunContext {
  readonly realServer: RealServerHandle;
  readonly toxiproxy: ToxiproxyClient | null;
  readonly opts: ConformanceRunOptions;
}

/**
 * Acquire the full context (real server + optional Toxiproxy) under one
 * Scope; Vitest's `beforeAll`/`afterAll` tick the scope.
 */
export function acquireRunContext(
  opts: ConformanceRunOptions,
): Effect.Effect<ConformanceRunContext, never, Scope.Scope> {
  throw new Error("not implemented");
}

/**
 * Entry point the Vitest suite file calls. Iterates `opts.tiers` and
 * delegates to each tier's runner. Not a test body itself — Vitest drives
 * `describe`/`it` from inside the tier modules.
 */
export function runConformance(
  ctx: ConformanceRunContext,
): Effect.Effect<void> {
  throw new Error("not implemented");
}
