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
import { FileSystem, Path } from "@effect/platform";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Cause, Chunk, Effect, Exit, Option } from "effect";
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
import type {
  RealServerAcquireError,
  ToxicControlError,
} from "../_shared/errors.js";
import {
  isAllowedCoverageGap,
  type AllowedCoverageGap,
} from "./coverage-policy.js";
import { conformanceArtifactDirFromEnv } from "./env.js";

import { TasksCreate } from "../../../task/methods.js";

const JSON_INDENT_SPACES = 2;
const TOXIPROXY_NOT_PROVISIONED = "Toxiproxy client not provisioned";
const BASE_ALLOWED_SERVER_COVERAGE_GAPS: ReadonlyArray<AllowedCoverageGap> = [
  {
    kind: "deferred",
    id: "adversity/backpressure",
    reasonIncludes: "issues/186",
  },
  {
    kind: "unavailable",
    id: "adversity/reset-peer-recovery",
    reasonIncludes: "reset_peer toxic did not close",
  },
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
  {
    kind: "deferred",
    id: "rpc-semantics/spurious-app-callback-frame-handling",
    reasonIncludes: "B.9",
  },
];
const TOXIPROXY_MISSING_ALLOWED_COVERAGE_GAPS: ReadonlyArray<AllowedCoverageGap> =
  [
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
  ];

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

interface SuiteAccumulator {
  readonly passed: string[];
  readonly deferred: { name: string; reason: string }[];
  readonly unavailable: { name: string; reason: string }[];
  readonly failed: SuiteResult["failed"][number][];
}

interface RunPropertyInput {
  readonly property: RegisteredProperty;
  readonly seed: number;
  readonly artifactDir: string;
  readonly allowedCoverageGaps: ReadonlyArray<AllowedCoverageGap>;
  readonly acc: SuiteAccumulator;
}

interface DefectRecordInput extends RunPropertyInput {
  readonly id: string;
  readonly exit: Exit.Exit<void, PropertyFailure>;
}

interface FailureRecordInput extends RunPropertyInput {
  readonly id: string;
  readonly failure: PropertyFailure;
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
    yield* ensureArtifactDir(artifactDir);
    const properties = collectProperties(ctx);
    const acc = emptySuiteAccumulator();
    for (const p of properties) {
      yield* runRegisteredProperty({
        property: p,
        seed: ctx.seed,
        artifactDir,
        allowedCoverageGaps,
        acc,
      });
    }
    return suiteResult(ctx.seed, acc);
  }).pipe(Effect.withSpan("runAllProperties"));
}

function emptySuiteAccumulator(): SuiteAccumulator {
  return { passed: [], deferred: [], unavailable: [], failed: [] };
}

function suiteResult(seed: number, acc: SuiteAccumulator): SuiteResult {
  return {
    seed,
    passed: acc.passed,
    deferred: acc.deferred,
    unavailable: acc.unavailable,
    failed: acc.failed,
  };
}

function runRegisteredProperty(input: RunPropertyInput): Effect.Effect<void> {
  return Effect.gen(function* () {
    const id = `${input.property.category}/${input.property.name}`;
    const exit = yield* Effect.exit(input.property.run);
    if (Exit.isSuccess(exit)) {
      input.acc.passed.push(id);
      return;
    }
    const failure = firstTypedFailure(exit);
    if (failure === null) {
      yield* recordDefect({ ...input, id, exit });
      return;
    }
    yield* recordTypedFailure({ ...input, id, failure });
  });
}

function recordDefect(input: DefectRecordInput): Effect.Effect<void> {
  const message = Exit.isFailure(input.exit)
    ? input.exit.cause.toString()
    : "<success>";
  input.acc.failed.push({
    name: input.id,
    failure: { _tag: "defect", message },
  });
  return writeArtifact(input.artifactDir, input.property, input.seed, {
    defect: message,
  });
}

function recordTypedFailure(input: FailureRecordInput): Effect.Effect<void> {
  switch (input.failure._tag) {
    case "ConformancePropertyDeferred":
      return recordDeferredFailure(input);
    case "ConformancePropertyUnavailable":
      return recordUnavailableFailure(input);
    case "ConformancePropertyAssertionFailure":
    case "ConformancePropertyInvariantViolation":
      return recordFailedProperty(input);
    default:
      return Effect.sync(() => recordUnhandledFailure(input));
  }
}

function recordDeferredFailure(input: FailureRecordInput): Effect.Effect<void> {
  const failure = input.failure;
  if (failure._tag !== "ConformancePropertyDeferred") return Effect.void;
  if (coverageGapAllowed(input, "deferred", failure.followUp)) {
    input.acc.deferred.push({ name: input.id, reason: failure.followUp });
    return Effect.void;
  }
  return recordFailedProperty(input);
}

function recordUnavailableFailure(
  input: FailureRecordInput,
): Effect.Effect<void> {
  const failure = input.failure;
  if (failure._tag !== "ConformancePropertyUnavailable") return Effect.void;
  if (coverageGapAllowed(input, "unavailable", failure.reason)) {
    input.acc.unavailable.push({ name: input.id, reason: failure.reason });
    return Effect.void;
  }
  return recordFailedProperty(input);
}

function coverageGapAllowed(
  input: FailureRecordInput,
  kind: "deferred" | "unavailable",
  reason: string,
): boolean {
  return isAllowedCoverageGap(
    input.allowedCoverageGaps,
    kind,
    input.id,
    reason,
  );
}

function recordFailedProperty(input: FailureRecordInput): Effect.Effect<void> {
  input.acc.failed.push({ name: input.id, failure: input.failure });
  return writeArtifact(
    input.artifactDir,
    input.property,
    input.seed,
    failureArtifact(input.failure),
  );
}

function recordUnhandledFailure(input: FailureRecordInput): void {
  const failure = input.failure;
  input.acc.failed.push({
    name: input.id,
    failure: {
      _tag: "defect",
      message: `unhandled failure tag: ${String(failure._tag)}`,
    },
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
  const configuredArtifactDir =
    opts.artifactDir ?? conformanceArtifactDirFromEnv();
  const categories: ConformanceRunOptions["tiers"] =
    toxiproxyUrl === null ? ["A", "B", "C", "E"] : ["A", "B", "C", "D", "E"];

  return Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const artifactDir =
        configuredArtifactDir ?? path.resolve("conformance-artifacts");
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
    }).pipe(Effect.withSpan("runConformanceSuite")),
  ).pipe(Effect.provide(NodePath.layer));
}

function allowedServerCoverageGaps(
  toxiproxyUrl: string | null,
): ReadonlyArray<AllowedCoverageGap> {
  return toxiproxyUrl === null
    ? [
        ...BASE_ALLOWED_SERVER_COVERAGE_GAPS,
        ...TOXIPROXY_MISSING_ALLOWED_COVERAGE_GAPS,
      ]
    : BASE_ALLOWED_SERVER_COVERAGE_GAPS;
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

function ensureArtifactDir(dir: string): Effect.Effect<void> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeDirectory(dir, { recursive: true })),
    Effect.provide(NodeFileSystem.layer),
    Effect.orDie,
  );
}

function writeArtifact(
  dir: string,
  property: RegisteredProperty,
  seed: number,
  payload: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(
      dir,
      `${property.category}-${property.name}.seed.json`,
    );
    yield* fs.writeFileString(
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
  }).pipe(
    Effect.provide(NodePath.layer),
    Effect.provide(NodeFileSystem.layer),
    Effect.orDie,
  );
}
