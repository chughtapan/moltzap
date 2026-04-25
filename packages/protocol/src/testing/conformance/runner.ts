/**
 * Conformance-suite runner.
 *
 * Orchestrates tiers A → E under one entrypoint so
 * `pnpm -F @moltzap/protocol test:conformance` is the only command a CI
 * job needs (AC11).
 *
 * Responsibilities:
 *   - receive a real MoltZap server handle (built externally to preserve
 *     AC13 one-way imports);
 *   - build a Toxiproxy client when Tier D is in scope;
 *   - pin fast-check seeds and export them on failure (AC10);
 *   - tear everything down in reverse order.
 */
import { Effect, Ref, Scope } from "effect";
import { makeToxiproxyClient, type ToxiproxyClient } from "../toxics/client.js";
import { RealServerAcquireError, ToxicControlError } from "../errors.js";
import { conformanceNumRunsFromEnv } from "./env.js";

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
  readonly close: () => Promise<void>;
}

export interface ConformanceRunOptions {
  readonly tiers: ReadonlyArray<"A" | "B" | "C" | "D" | "E">;
  /** Supplier for the real server; invoked once per run. */
  readonly realServer: () => Promise<RealServerHandle>;
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
    const seed =
      effectiveOpts.replaySeed ??
      Number(process.env.FC_SEED ?? Date.now() & 0x7fffffff);
    const artifacts = yield* Ref.make<ReadonlyArray<ConformanceArtifact>>([]);

    const realServer = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => opts.realServer(),
        catch: (cause) => new RealServerAcquireError({ cause }),
      }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: () => new Error("realServer.close() threw"),
        }).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.asVoid,
        ),
    );

    let toxiproxy: ToxiproxyClient | null = null;
    if (effectiveOpts.tiers.includes("D")) {
      const url = effectiveOpts.toxiproxyUrl ?? "http://127.0.0.1:8474";
      toxiproxy = yield* makeToxiproxyClient({ apiUrl: url });
      yield* toxiproxy.ping.pipe(
        Effect.retry({ times: 10, schedule: undefined }),
      );
    }

    return {
      realServer,
      toxiproxy,
      opts: effectiveOpts,
      seed,
      artifacts,
    } satisfies ConformanceRunContext;
  });
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
  return Effect.sync(() => {
    console.log(
      `[conformance] seed=${ctx.seed} tiers=${ctx.opts.tiers.join(",")} toxiproxy=${ctx.toxiproxy !== null}`,
    );
  });
}
