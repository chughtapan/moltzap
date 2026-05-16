/**
 * Conformance-suite runner.
 *
 * Orchestrates tiers A → E under one entrypoint so
 * the protocol package's `test:conformance` script is the only command a
 * CI job needs (AC11).
 *
 * Responsibilities:
 *   - receive a real MoltZap server handle (built externally to preserve
 *     AC13 one-way imports);
 *   - build a Toxiproxy client when Tier D is in scope;
 *   - pin fast-check seeds and export them on failure (AC10);
 *   - tear everything down in reverse order.
 */
import { Config, ConfigProvider, Effect, Ref, type Scope } from "effect";
import {
  makeToxiproxyClient,
  type ToxiproxyClient,
} from "../../toxics/client.js";
import { RealServerAcquireError } from "./errors.js";
import { ToxicControlError } from "../../toxics/errors.js";
import { conformanceNumRunsFromEnv } from "./env.js";

const REPLAY_SEED_MASK = 0x7fffffff;

const loadFastCheckSeed: Effect.Effect<number, never> = Config.integer(
  "FC_SEED",
).pipe(
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
  Effect.orElseSucceed(() => Date.now() & REPLAY_SEED_MASK),
);

/**
 * Opaque handle to a running real MoltZap server. The conformance runner
 * accepts this as an injected dependency so the protocol package has no
 * compile-time import of `packages/server` (AC13). The consuming suite
 * file supplies a concrete value built from `startCoreTestServer`.
 */
export interface RealServerHandle {
  readonly wsUrl: string;
  readonly baseUrl: string;
  /** Teardown hook; the runner's Scope calls this on release. */
  readonly close: Effect.Effect<void>;
}

export interface ConformanceRunOptions {
  readonly tiers: ReadonlyArray<"A" | "B" | "C" | "D" | "E">;
  /** Supplier for the real server; invoked once per run. */
  readonly realServer: Effect.Effect<RealServerHandle, RealServerAcquireError>;
  /** If provided, replay this exact fast-check seed (AC10 reproducibility). */
  readonly replaySeed?: number;
  /** Number of runs per property; fast-check default is 100. */
  readonly numRuns?: number;
  /** When `true`, bring up docker-compose Toxiproxy; else assume running. */
  readonly manageToxiproxy?: boolean;
  /** Toxiproxy control URL — defaults to `http://127.0.0.1:8474`. */
  readonly toxiproxyUrl?: string;
  /** Output directory for seed + toxic-config dump on failure. */
  readonly artifactDir?: string;
}

export interface ConformanceRunContext {
  readonly realServer: RealServerHandle;
  readonly toxiproxy: ToxiproxyClient | null;
  readonly opts: ConformanceRunOptions;
  /** Seed to pin every property to. Exported on failure for replay. */
  readonly seed: number;
  /**
   * Per-property artifact sink. The tier modules call `record` to stash a
   * seed + toxic profile when a property fails; the suite post-process
   * writes to `opts.artifactDir`.
   */
  readonly artifacts: Ref.Ref<ReadonlyArray<ConformanceArtifact>>;
}

export interface ConformanceArtifact {
  readonly tierId: string;
  readonly propId: string;
  readonly seed: number;
  readonly toxicProfile?: string;
  readonly commandSequence?: ReadonlyArray<unknown>;
  readonly captures?: ReadonlyArray<unknown>;
}

/**
 * Acquire the full context (real server + optional Toxiproxy) under one
 * Scope; Vitest's `beforeAll`/`afterAll` tick the scope.
 */
export function acquireRunContext(
  opts: ConformanceRunOptions,
): Effect.Effect<
  ConformanceRunContext,
  ToxicControlError | RealServerAcquireError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const effectiveOpts = {
      ...opts,
      numRuns: opts.numRuns ?? conformanceNumRunsFromEnv(),
    };
    const seed = effectiveOpts.replaySeed ?? (yield* loadFastCheckSeed);
    const artifacts = yield* Ref.make<ReadonlyArray<ConformanceArtifact>>([]);

    const realServer = yield* opts.realServer;
    yield* Effect.addFinalizer(() =>
      realServer.close.pipe(Effect.orElseSucceed(() => undefined)),
    );

    let toxiproxy: ToxiproxyClient | null = null;
    if (effectiveOpts.tiers.includes("D")) {
      const url = effectiveOpts.toxiproxyUrl ?? "http://127.0.0.1:8474";
      toxiproxy = yield* makeToxiproxyClient({ apiUrl: url });
      yield* toxiproxy.ping.pipe(Effect.retry({ times: 10 }));
    }

    return {
      realServer,
      toxiproxy,
      opts: effectiveOpts,
      seed,
      artifacts,
    } satisfies ConformanceRunContext;
  }).pipe(Effect.withSpan("acquireRunContext"));
}

/**
 * Entry point the runner script calls. Iterates `opts.tiers` and writes a
 * summary line per tier; the actual properties register themselves with
 * Vitest via each tier module's `register*` functions — so this only
 * orchestrates output + seed plumbing.
 */
export function runConformance(
  ctx: ConformanceRunContext,
): Effect.Effect<void> {
  return Effect.logInfo(
    `[conformance] seed=${ctx.seed} tiers=${ctx.opts.tiers.join(",")} toxiproxy=${ctx.toxiproxy !== null}`,
  );
}
