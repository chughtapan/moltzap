/**
 * Client-side conformance suite entry point.
 *
 * O4 decision: **option (c) — one library, both factories optional.**
 * The architect's target surface is the existing `runConformanceSuite(opts)`
 * extended with a `realClient?` field alongside `realServer?`. The suite
 * registers every server-side property when `realServer` is present and
 * every client-side property when `realClient` is present. A caller that
 * passes both gets the joint run for free; a caller that passes neither
 * fails at option-decode time.
 *
 * This module ships the **client-only** entry — `runClientConformanceSuite`
 * — as the stub the implementer wires in. When `implement-staff` lands the
 * body it folds this into a single extended `runConformanceSuite` whose
 * signature is declared in §Interfaces of the design doc. The stub exists
 * so consumers and CI wiring have a stable symbol to import against while
 * the merge lands.
 *
 * Scope: dependency on `packages/client` or either channel package is
 * forbidden (extends AC13 to AC14). The factory injection pattern keeps
 * the protocol package leaf-of-the-graph.
 */
import type { Effect } from "effect";
import type {
  ClientConformanceRunContext,
  ClientConformanceRunOptions,
  RealClientHandle,
  RealClientLifecycleError,
} from "./runner.js";
import type { PropertyFailure } from "../registry.js";
import type {
  RealServerAcquireError,
  ToxicControlError,
} from "../../errors.js";
import type { SuiteResult } from "../suite.js";

/**
 * Consumer-facing options. Mirror of `ConformanceSuiteOptions` on the
 * server side; only the factory name differs.
 */
export interface ClientConformanceSuiteOptions {
  /** Factory for the real MoltZap client under test, owned by the suite's Scope. */
  readonly realClient: () => Effect.Effect<
    RealClientHandle,
    RealClientLifecycleError,
    never
  >;
  /**
   * Toxiproxy control-plane URL. When `null`, adversity properties are
   * registered and surface `PropertyUnavailable`. Mirrors server-side
   * behavior.
   */
  readonly toxiproxyUrl?: string | null;
  readonly replaySeed?: number;
  readonly numRuns?: number;
  readonly artifactDir?: string;
  /**
   * Default `true`. When `true`, TestServer binds behind Toxiproxy so
   * adversity toxics shape the wire between TestServer and the real
   * client. Set to `false` only for debugging.
   */
  readonly bindThroughToxiproxy?: boolean;
}

/**
 * Register every client-side property (A2, A4, B1, B4, C1, C3, C4, D1,
 * D3, D4, D5, D6, E2 — 13 total per spec amendment #200 §5) against
 * `ctx`. Property files in `conformance/client/*.ts` each export one
 * `registerXxxClient` per spec-amendment registrar; this helper is the
 * single call site.
 */
export function registerAllClientProperties(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}

/**
 * End-to-end client-side library entry. Acquires context, registers
 * every client-side property, runs them, closes Scope. Returns a
 * typed `SuiteResult` (reused from server-side — same failure shape).
 */
export function runClientConformanceSuite(
  opts: ClientConformanceSuiteOptions,
): Effect.Effect<
  SuiteResult,
  ToxicControlError | RealServerAcquireError | RealClientLifecycleError
> {
  throw new Error("not implemented");
}

/**
 * Joint-run entry — passed both `realServer?` and `realClient?`.
 * Architect target shape per O4 (c). Implementer folds this into
 * `runConformanceSuite` in `../suite.ts` as an extension of
 * `ConformanceSuiteOptions`; the stub declares the joint signature
 * here so the design doc has a concrete symbol to trace.
 *
 * This signature is **not** the final exported surface — the merged
 * `runConformanceSuite` in `../suite.ts` replaces it. Declared here
 * for cold-read traceability only.
 */
export interface JointConformanceSuiteOptions {
  readonly realServer?: ClientConformanceSuiteOptions["realClient"] extends never
    ? never
    : unknown;
  readonly realClient?: ClientConformanceSuiteOptions["realClient"];
  readonly toxiproxyUrl?: string | null;
  readonly replaySeed?: number;
  readonly numRuns?: number;
  readonly artifactDir?: string;
  readonly bindThroughToxiproxy?: boolean;
}
