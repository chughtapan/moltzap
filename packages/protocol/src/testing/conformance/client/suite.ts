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
import { Cause, Chunk, Effect, Exit, Option, type Scope } from "effect";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireClientRunContext } from "./runner.js";
import type {
  ClientConformanceRunContext,
  ClientConformanceRunOptions,
  RealClientHandle,
  RealClientLifecycleError,
} from "./runner.js";
import {
  collectProperties,
  type PropertyFailure,
  type RegisteredProperty,
} from "../registry.js";
import type {
  RealServerAcquireError,
  ToxicControlError,
} from "../../errors.js";
import type { SuiteResult } from "../suite.js";
import {
  isAllowedCoverageGap,
  type AllowedCoverageGap,
} from "../coverage-policy.js";
import {
  registerEventWellFormednessClient,
  registerMalformedFrameHandlingClient,
} from "./schema-conformance.js";
import {
  registerModelEquivalenceClient,
  registerRequestIdUniquenessClient,
} from "./rpc-semantics.js";
import {
  registerFanOutCardinalityClient,
  registerPayloadOpacityClient,
  registerTaskBoundaryIsolationClient,
} from "./delivery.js";
import {
  registerLatencyResilienceClient,
  registerResetPeerRecoveryClient,
  registerSlicerFramingClient,
  registerSlowCloseCleanupClient,
  registerTimeoutSurfaceClient,
} from "./adversity.js";
import { registerSchemaExhaustiveFuzzClient } from "./boundary.js";

/**
 * Consumer-facing options. Mirror of `ConformanceSuiteOptions` on the
 * server side; only the factory name differs.
 */
export interface ClientConformanceSuiteOptions {
  /**
   * Factory for the real MoltZap client under test, owned by the
   * suite's Scope. Receives `testServerUrl` from the suite so the real
   * client can point its WS socket at the bound TestServer substrate.
   */
  readonly realClient: (args: {
    readonly testServerUrl: string;
  }) => Effect.Effect<RealClientHandle, RealClientLifecycleError, Scope.Scope>;
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
  registerEventWellFormednessClient(ctx);
  registerMalformedFrameHandlingClient(ctx);
  registerModelEquivalenceClient(ctx);
  registerRequestIdUniquenessClient(ctx);
  registerFanOutCardinalityClient(ctx);
  registerPayloadOpacityClient(ctx);
  registerTaskBoundaryIsolationClient(ctx);
  registerSchemaExhaustiveFuzzClient(ctx);
  registerLatencyResilienceClient(ctx);
  registerSlicerFramingClient(ctx);
  registerResetPeerRecoveryClient(ctx);
  registerTimeoutSurfaceClient(ctx);
  registerSlowCloseCleanupClient(ctx);
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
  const toxiproxyUrl = opts.toxiproxyUrl ?? null;
  const artifactDir =
    opts.artifactDir ?? path.resolve(process.cwd(), "conformance-artifacts");
  const tiers: ClientConformanceRunOptions["tiers"] =
    toxiproxyUrl === null ? ["A", "B", "C", "E"] : ["A", "B", "C", "D", "E"];

  return Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* acquireClientRunContext({
        tiers,
        realClient: opts.realClient,
        toxiproxyUrl: toxiproxyUrl ?? undefined,
        manageToxiproxy: false,
        replaySeed: opts.replaySeed,
        numRuns: opts.numRuns,
        artifactDir,
        bindThroughToxiproxy: opts.bindThroughToxiproxy,
      });
      registerAllClientProperties(ctx);
      return yield* runAllClientProperties(
        ctx,
        artifactDir,
        allowedClientCoverageGaps(toxiproxyUrl),
      );
    }),
  );
}

function allowedClientCoverageGaps(
  toxiproxyUrl: string | null,
): ReadonlyArray<AllowedCoverageGap> {
  const gaps: AllowedCoverageGap[] = [
    {
      kind: "unavailable",
      id: "adversity/slicer-framing-client",
      reasonIncludes: "slicer toxic property deferred",
    },
    {
      kind: "unavailable",
      id: "adversity/reset-peer-recovery-client",
      reasonIncludes: "reset_peer property deferred",
    },
  ];
  if (toxiproxyUrl === null) {
    gaps.push(
      {
        kind: "unavailable",
        id: "adversity/latency-resilience-client",
        reasonIncludes: "Toxiproxy not provisioned",
      },
      {
        kind: "unavailable",
        id: "adversity/slicer-framing-client",
        reasonIncludes: "Toxiproxy not provisioned",
      },
      {
        kind: "unavailable",
        id: "adversity/reset-peer-recovery-client",
        reasonIncludes: "Toxiproxy not provisioned",
      },
    );
  }
  return gaps;
}

/**
 * Execute every registered client property and return a typed
 * `SuiteResult`. Mirrors the server-side `runAllProperties` shape so
 * downstream consumers share one assertion surface.
 */
function runAllClientProperties(
  ctx: ClientConformanceRunContext,
  artifactDir: string,
  allowedCoverageGaps: ReadonlyArray<AllowedCoverageGap>,
): Effect.Effect<SuiteResult> {
  return Effect.gen(function* () {
    if (!existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: true });
    const properties = collectProperties(ctx);
    const passed: string[] = [];
    const deferred: { name: string; reason: string }[] = [];
    const unavailable: { name: string; reason: string }[] = [];
    const failed: SuiteResult["failed"][number][] = [];

    for (const p of properties) {
      const id = `${p.category}/${p.name}`;
      const exit = yield* Effect.exit(p.run);
      if (Exit.isSuccess(exit)) {
        passed.push(id);
        continue;
      }
      const failure = firstTypedFailure(exit);
      if (failure === null) {
        const msg = exit.cause.toString();
        failed.push({ name: id, failure: { _tag: "defect", message: msg } });
        writeArtifact(artifactDir, p, ctx.seed, { defect: msg });
        continue;
      }
      switch (failure._tag) {
        case "ConformancePropertyDeferred":
          if (
            isAllowedCoverageGap(
              allowedCoverageGaps,
              "deferred",
              id,
              failure.followUp,
            )
          ) {
            deferred.push({ name: id, reason: failure.followUp });
            break;
          }
          failed.push({ name: id, failure });
          writeArtifact(artifactDir, p, ctx.seed, failureArtifact(failure));
          break;
        case "ConformancePropertyUnavailable":
          if (
            isAllowedCoverageGap(
              allowedCoverageGaps,
              "unavailable",
              id,
              failure.reason,
            )
          ) {
            unavailable.push({ name: id, reason: failure.reason });
            break;
          }
          failed.push({ name: id, failure });
          writeArtifact(artifactDir, p, ctx.seed, failureArtifact(failure));
          break;
        case "ConformancePropertyAssertionFailure":
        case "ConformancePropertyInvariantViolation":
          failed.push({ name: id, failure });
          writeArtifact(artifactDir, p, ctx.seed, failureArtifact(failure));
          break;
        default: {
          const _exhaustive: never = failure;
          failed.push({
            name: id,
            failure: {
              _tag: "defect",
              message: `unhandled failure tag: ${String(_exhaustive)}`,
            },
          });
        }
      }
    }
    return { seed: ctx.seed, passed, deferred, unavailable, failed };
  });
}

function firstTypedFailure(
  exit: Exit.Exit<void, PropertyFailure>,
): PropertyFailure | null {
  if (Exit.isSuccess(exit)) return null;
  const failures = Cause.failures(exit.cause);
  const head = Chunk.head(failures);
  return Option.getOrNull(head);
}

function failureArtifact(failure: PropertyFailure): Record<string, unknown> {
  switch (failure._tag) {
    case "ConformancePropertyAssertionFailure":
      return { tag: failure._tag, cause: String(failure.cause) };
    case "ConformancePropertyInvariantViolation":
    case "ConformancePropertyUnavailable":
      return { tag: failure._tag, reason: failure.reason };
    case "ConformancePropertyDeferred":
      return { tag: failure._tag, followUp: failure.followUp };
    default: {
      const _exhaustive: never = failure;
      return { tag: "unknown", value: String(_exhaustive) };
    }
  }
}

function writeArtifact(
  dir: string,
  property: RegisteredProperty,
  seed: number,
  payload: Record<string, unknown>,
): void {
  const file = path.join(
    dir,
    `client-${property.category}-${property.name}.seed.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      {
        category: property.category,
        name: property.name,
        seed,
        ...payload,
      },
      null,
      2,
    ),
  );
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
