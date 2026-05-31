/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */

/**
 * Client-side conformance suite entry point.
 *
 * One library, both factories optional: `runConformanceSuite(opts)` takes
 * a `realClient?` field alongside `realServer?`. The suite registers every
 * server-side property when `realServer` is present and every client-side
 * property when `realClient` is present. A caller that passes both gets the
 * joint run; a caller that passes neither fails at option-decode time.
 *
 * This module is the **client-only** entry, `runClientConformanceSuite`.
 *
 * The protocol package must not depend on `packages/client` or either
 * channel package. The factory injection pattern keeps the protocol
 * package leaf-of-the-graph.
 */
import { FileSystem, Path } from "@effect/platform";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Cause, Chunk, Effect, Exit, Option, type Scope } from "effect";
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
} from "../_shared/registry.js";
import type { RealServerAcquireError } from "../_shared/errors.js";
import type { ToxicControlError } from "../../toxics/errors.js";
import type { SuiteResult } from "../_shared/suite.js";
import { conformanceArtifactDirFromEnv } from "../_shared/env.js";
import {
  isAllowedCoverageGap,
  type AllowedCoverageGap,
} from "../_shared/coverage-policy.js";
import {
  registerNotificationWellFormednessClient,
  registerMalformedFrameHandlingClient,
} from "./schema-conformance.js";
import {
  registerModelEquivalenceClient,
  registerRequestIdUniquenessClient,
} from "./rpc-semantics.js";
import {
  registerArchiveLifecycleClient,
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

const JSON_INDENT_SPACES = 2;

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

interface ClientSuiteAccumulator {
  readonly passed: string[];
  readonly deferred: { name: string; reason: string }[];
  readonly unavailable: { name: string; reason: string }[];
  readonly failed: SuiteResult["failed"][number][];
}

interface ClientRunPropertyInput {
  readonly property: RegisteredProperty;
  readonly seed: number;
  readonly artifactDir: string;
  readonly allowedCoverageGaps: ReadonlyArray<AllowedCoverageGap>;
  readonly acc: ClientSuiteAccumulator;
}

interface ClientDefectRecordInput extends ClientRunPropertyInput {
  readonly id: string;
  readonly exit: Exit.Exit<void, PropertyFailure>;
}

interface ClientFailureRecordInput extends ClientRunPropertyInput {
  readonly id: string;
  readonly failure: PropertyFailure;
}

/**
 * Register every client-side property (14 total) against `ctx`. Property
 * files in `conformance/client/*.ts` each export one `registerXxxClient`
 * registrar; this helper is the single call site.
 */
export function registerAllClientProperties(
  ctx: ClientConformanceRunContext,
): void {
  registerNotificationWellFormednessClient(ctx);
  registerMalformedFrameHandlingClient(ctx);
  registerModelEquivalenceClient(ctx);
  registerRequestIdUniquenessClient(ctx);
  registerFanOutCardinalityClient(ctx);
  registerPayloadOpacityClient(ctx);
  registerTaskBoundaryIsolationClient(ctx);
  registerArchiveLifecycleClient(ctx);
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
 *
 * The conformance suite defines properties any compliant
 * client/server pair must satisfy. Each property ships an
 * **executable** (a divergence proof) that intentionally fails the
 * property to prove the assertion has teeth.
 *
 * ```mermaid
 * flowchart TD
 *   A["src/testing/conformance/{layer}/&lt;property>.ts"]
 *   A --> B["property body — Effect that asserts the invariant"]
 *   A --> C["__divergence_proofs__/&lt;property>.proofs.test.ts<br>(server intentionally violates invariant)"]
 *   C --> D[vitest runs the proof: failure-of-failure = pass]
 * ```
 *
 * External consumers (e.g. `moltzap-arena`) drop a ~20-line vitest
 * wrapper matching the AC22 template (see
 * `packages/protocol/CLAUDE.md`) and the suite runs against their
 * real WS client.
 */
export function runClientConformanceSuite(
  opts: ClientConformanceSuiteOptions,
): Effect.Effect<
  SuiteResult,
  ToxicControlError | RealServerAcquireError | RealClientLifecycleError
> {
  const toxiproxyUrl = opts.toxiproxyUrl ?? null;
  const configuredArtifactDir =
    opts.artifactDir ?? conformanceArtifactDirFromEnv();
  const tiers: ClientConformanceRunOptions["tiers"] =
    toxiproxyUrl === null ? ["A", "B", "C", "E"] : ["A", "B", "C", "D", "E"];

  return Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const artifactDir =
        configuredArtifactDir ?? path.resolve("conformance-artifacts");
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
    }).pipe(Effect.withSpan("runClientConformanceSuite")),
  ).pipe(Effect.provide(NodePath.layer));
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
    yield* ensureArtifactDir(artifactDir);
    const properties = collectProperties(ctx);
    const acc = emptyClientSuiteAccumulator();
    for (const p of properties) {
      yield* runClientProperty({
        property: p,
        seed: ctx.seed,
        artifactDir,
        allowedCoverageGaps,
        acc,
      });
    }
    return clientSuiteResult(ctx.seed, acc);
  });
}

function emptyClientSuiteAccumulator(): ClientSuiteAccumulator {
  return { passed: [], deferred: [], unavailable: [], failed: [] };
}

function clientSuiteResult(
  seed: number,
  acc: ClientSuiteAccumulator,
): SuiteResult {
  return {
    seed,
    passed: acc.passed,
    deferred: acc.deferred,
    unavailable: acc.unavailable,
    failed: acc.failed,
  };
}

function runClientProperty(input: ClientRunPropertyInput): Effect.Effect<void> {
  return Effect.gen(function* () {
    const id = `${input.property.category}/${input.property.name}`;
    const exit = yield* Effect.exit(input.property.run);
    if (Exit.isSuccess(exit)) {
      input.acc.passed.push(id);
      return;
    }
    const failure = firstTypedFailure(exit);
    if (failure === null) {
      yield* recordClientDefect({ ...input, id, exit });
      return;
    }
    yield* recordClientFailure({ ...input, id, failure });
  });
}

function recordClientDefect(
  input: ClientDefectRecordInput,
): Effect.Effect<void> {
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

function recordClientFailure(
  input: ClientFailureRecordInput,
): Effect.Effect<void> {
  switch (input.failure._tag) {
    case "ConformancePropertyDeferred":
      return recordClientDeferred(input);
    case "ConformancePropertyUnavailable":
      return recordClientUnavailable(input);
    case "ConformancePropertyAssertionFailure":
    case "ConformancePropertyInvariantViolation":
      return recordClientFailedProperty(input);
    default:
      return Effect.sync(() => recordClientUnhandledFailure(input));
  }
}

function recordClientDeferred(
  input: ClientFailureRecordInput,
): Effect.Effect<void> {
  const failure = input.failure;
  if (failure._tag !== "ConformancePropertyDeferred") return Effect.void;
  if (clientCoverageGapAllowed(input, "deferred", failure.followUp)) {
    input.acc.deferred.push({ name: input.id, reason: failure.followUp });
    return Effect.void;
  }
  return recordClientFailedProperty(input);
}

function recordClientUnavailable(
  input: ClientFailureRecordInput,
): Effect.Effect<void> {
  const failure = input.failure;
  if (failure._tag !== "ConformancePropertyUnavailable") return Effect.void;
  if (clientCoverageGapAllowed(input, "unavailable", failure.reason)) {
    input.acc.unavailable.push({ name: input.id, reason: failure.reason });
    return Effect.void;
  }
  return recordClientFailedProperty(input);
}

function clientCoverageGapAllowed(
  input: ClientFailureRecordInput,
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

function recordClientFailedProperty(
  input: ClientFailureRecordInput,
): Effect.Effect<void> {
  input.acc.failed.push({ name: input.id, failure: input.failure });
  return writeArtifact(
    input.artifactDir,
    input.property,
    input.seed,
    failureArtifact(input.failure),
  );
}

function recordClientUnhandledFailure(input: ClientFailureRecordInput): void {
  const failure = input.failure;
  input.acc.failed.push({
    name: input.id,
    failure: {
      _tag: "defect",
      message: `unhandled failure tag: ${String(failure._tag)}`,
    },
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
      `client-${property.category}-${property.name}.seed.json`,
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

/**
 * Joint-run option shape — both `realServer?` and `realClient?` supplied,
 * so the suite exercises a real client against a real server in one run.
 * The merged `runConformanceSuite` in `../suite.ts` accepts these fields
 * as an extension of `ConformanceSuiteOptions`.
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
