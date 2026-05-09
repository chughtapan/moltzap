/**
 * Conformance suite — library-shaped entry point consumers call.
 *
 * `runConformanceSuite` is the single surface any real implementation
 * (the core server, a third-party server, a packages/client-side
 * TestServer harness, openclaw-channel, arena, …) invokes to exercise
 * every property in this subpath.
 *
 * Dependency shape:
 *   - Protocol imports nothing from consumers (no `packages/server`, no
 *     `packages/client`, no test-runner globals).
 *   - Consumers import `@moltzap/protocol/testing` and pass their real
 *     server handle (and optionally a Toxiproxy URL).
 *     That's the only cross-package coupling.
 *
 * Docker-compose spinup and vitest describe/it scaffolding are consumer
 * concerns — the suite here is Effect-native and returns a typed
 * `SuiteResult`. A consumer running under vitest asserts
 * `result.failed.length === 0` and is done.
 */
import { Cause, Chunk, Effect, Exit, Option } from "effect";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  acquireRunContext,
  type ConformanceRunContext,
  type ConformanceRunOptions,
  type RealServerHandle,
} from "./runner.js";
import {
  collectProperties,
  type PropertyFailure,
  type RegisteredProperty,
} from "./registry.js";
import { TRANSPORT_PROPERTIES } from "../transport/index.js";
import { IDENTITY_PROPERTIES } from "../identity/index.js";
import { NETWORK_PROPERTIES } from "../network/index.js";
import { TASK_PROPERTIES } from "../task/index.js";
import { APP_PROPERTIES } from "../app/index.js";
import type { RealServerAcquireError } from "./errors.js";
import type { ToxicControlError } from "../../toxics/errors.js";
import {
  isAllowedCoverageGap,
  type AllowedCoverageGap,
} from "./coverage-policy.js";
import { conformanceArtifactDirFromEnv } from "./env.js";

import { TasksCreate } from "../../../task/methods.js";

const JSON_INDENT_SPACES = 2;
const TOXIPROXY_NOT_PROVISIONED = "Toxiproxy client not provisioned";

/**
 * Input shape — consumer names the concrete implementation under test and
 * any optional capabilities they can provide (Toxiproxy).
 */
export interface ConformanceSuiteOptions {
  /** Factory for the implementation under test (server handle). */
  readonly realServer: Effect.Effect<RealServerHandle, RealServerAcquireError>;
  /**
   * Toxiproxy control-plane URL. When `null`, the adversity category is
   * skipped (registered properties return `PropertyUnavailable`).
   */
  readonly toxiproxyUrl?: string | null;
  /** Replay seed. Defaults to `FC_SEED` env var or a timestamp. */
  readonly replaySeed?: number;
  /** Per-property fast-check `numRuns` override. Default: library default. */
  readonly numRuns?: number;
  /** Directory for per-property failure artifacts. Defaults to `./conformance-artifacts`. */
  readonly artifactDir?: string;
}

export interface SuiteResult {
  readonly seed: number;
  readonly passed: ReadonlyArray<string>;
  readonly deferred: ReadonlyArray<{
    readonly name: string;
    readonly reason: string;
  }>;
  readonly unavailable: ReadonlyArray<{
    readonly name: string;
    readonly reason: string;
  }>;
  readonly failed: ReadonlyArray<{
    readonly name: string;
    readonly failure:
      | PropertyFailure
      | { readonly _tag: "defect"; readonly message: string };
  }>;
}

/**
 * Register every property against `ctx`. Consumers that want a narrower
 * run build a `ConformanceRunContext` directly and call only the layer
 * subset they need; `runConformanceSuite` uses this helper to register
 * the full set across all layers.
 */
export function registerAllProperties(ctx: ConformanceRunContext): void {
  for (const fn of [
    ...TRANSPORT_PROPERTIES,
    ...IDENTITY_PROPERTIES,
    ...NETWORK_PROPERTIES,
    ...TASK_PROPERTIES,
    ...APP_PROPERTIES,
  ]) {
    fn(ctx);
  }
}

/**
 * Run every registered property and collect a typed `SuiteResult`. Does
 * not throw: failures land in `result.failed`; a vitest boundary asserts
 * `result.failed.length === 0`.
 */
export function runAllProperties(
  ctx: ConformanceRunContext,
  artifactDir: string,
  allowedCoverageGaps: ReadonlyArray<AllowedCoverageGap> = [],
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

/**
 * End-to-end library entry: acquire context, register all properties,
 * run them, close scope. The returned `SuiteResult` is the single thing
 * a consumer asserts on.
 *
 * The ambient `Scope` is internal — the outer scope closes when the
 * Effect completes. Consumers don't need to pass a Scope.
 */
export function runConformanceSuite(
  opts: ConformanceSuiteOptions,
): Effect.Effect<SuiteResult, ToxicControlError | RealServerAcquireError> {
  const toxiproxyUrl = opts.toxiproxyUrl ?? null;
  const artifactDir =
    opts.artifactDir ??
    conformanceArtifactDirFromEnv() ??
    path.resolve(process.cwd(), "conformance-artifacts");
  const categories: ConformanceRunOptions["tiers"] =
    toxiproxyUrl === null ? ["A", "B", "C", "E"] : ["A", "B", "C", "D", "E"];

  return Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* acquireRunContext({
        tiers: categories,
        realServer: opts.realServer,
        toxiproxyUrl: toxiproxyUrl ?? undefined,
        manageToxiproxy: false, // consumer brings up Toxiproxy
        replaySeed: opts.replaySeed,
        numRuns: opts.numRuns,
        artifactDir,
      });
      registerAllProperties(ctx);
      return yield* runAllProperties(
        ctx,
        artifactDir,
        allowedServerCoverageGaps(toxiproxyUrl),
      );
    }),
  );
}

function allowedServerCoverageGaps(
  toxiproxyUrl: string | null,
): ReadonlyArray<AllowedCoverageGap> {
  const gaps: AllowedCoverageGap[] = [
    {
      kind: "unavailable",
      id: "adversity/reset-peer-recovery",
      reasonIncludes: "reset_peer toxic did not close",
    },
    // Hook-gated delivery, multi-app FIFO short-circuit, and
    // app-disconnect fail-policy properties gate on hook-routing
    // surface that the layered refactor reshaped. They short-circuit
    // to PropertyDeferred citing TasksCreate as the gating dependency
    // until #560 lands `runMessageAuthorize`. Both PropertyUnavailable
    // and PropertyDeferred outcomes are accepted (the boundary fixture
    // acquires more state than the delivery fixtures and therefore can
    // self-report Unavailable earlier in its setup).
    {
      kind: "deferred",
      id: "delivery/hook-gated-delivery",
      reasonIncludes: TasksCreate.name,
    },
    {
      kind: "deferred",
      id: "delivery/multi-app-fifo-short-circuit",
      reasonIncludes: TasksCreate.name,
    },
    {
      kind: "unavailable",
      id: "boundary/app-disconnect-fail-policy",
      reasonIncludes: TasksCreate.name,
    },
  ];
  if (toxiproxyUrl === null) {
    gaps.push(
      {
        kind: "unavailable",
        id: "adversity/latency-resilience",
        reasonIncludes: TOXIPROXY_NOT_PROVISIONED,
      },
      {
        kind: "unavailable",
        id: "adversity/slicer-framing",
        reasonIncludes: TOXIPROXY_NOT_PROVISIONED,
      },
      {
        kind: "unavailable",
        id: "adversity/reset-peer-recovery",
        reasonIncludes: TOXIPROXY_NOT_PROVISIONED,
      },
      {
        kind: "unavailable",
        id: "adversity/timeout-surface",
        reasonIncludes: TOXIPROXY_NOT_PROVISIONED,
      },
      {
        kind: "unavailable",
        id: "adversity/slow-close-cleanup",
        reasonIncludes: TOXIPROXY_NOT_PROVISIONED,
      },
    );
  }
  return gaps;
}

/**
 * Extract the first typed `PropertyFailure` from an Exit. Uses Effect's
 * `Cause.failures` so typed failures stay typed without bypassing the
 * type system; defects land as `null` and the caller reports them
 * under `_tag: "defect"`.
 */
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
    `${property.category}-${property.name}.seed.json`,
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
      JSON_INDENT_SPACES,
    ),
  );
}
