/**
 * @file Composition-root internals behind `run` (contract 4). The
 * manifest persists before server bring-up, so every post-manifest
 * failure has a recording; the episode races every long-lived failure
 * channel; shutdown follows the binding sequence (evented teardown, then
 * the post-stop transcript sweep, then log seal, trace write, and store
 * seal); the `InfraError` union maps onto the closed failure-reason
 * taxonomy exhaustively at the seal site.
 *
 * The transcript-drain factory is injectable here so hermetic tests can
 * substitute drains; the public default stays `makeTranscriptDrain`.
 */
import { createRequire } from "node:module";
import { Brand, Effect, Option, Schema, type Scope } from "effect";
import { LogicalSequence, wallTimeNow } from "./ids.js";
import {
  JsonValue,
  LogicalTime,
  RunSpec,
  materializeRunSpec,
  type AgentFacingRunSpec,
  type MaterializedRunSpec,
  type SpecHash,
} from "./run-spec.js";
import {
  AgentProvenance,
  EpisodeOutcome,
  FailureOutcome,
  ManifestJson,
  RECORDING_SCHEMA_VERSION,
  RecordingIdentity,
  ResultJson,
  makeSecrets,
  type AllocatedAttempt,
  type EpisodeTermination,
  type FailureReason,
  type RecordingRef,
  type RecordingStore,
  type RunOutcome,
  type SealedRecordingRef,
  type Secrets,
} from "./recording.js";
import {
  makeEventLog,
  makeReceiver,
  makeTranscriptDrain,
  type EventLog,
  type LogicalClock,
  type Receiver,
  type ServerStorageAccess,
  type TranscriptDrain,
} from "./event-log.js";
import { makeWorld, type World } from "./world.js";
import { makeEnvironment, type Environment } from "./environment.js";
import type { Principal } from "./episode.js";
import {
  makeLauncher,
  resolveReceiverBindHost,
  type Launcher,
  type Society,
} from "./run-config.js";
import {
  makeLocalRecordingStore,
  mintSealedFromEvidence,
} from "./local-store.js";
import { makePrincipal } from "./drivers.js";
import { episodeRun } from "./episode-live.js";
import { NANOCLAW_PINNED_SHA } from "../nanoclaw-install.js";
import {
  SealFailed,
  TranscriptDrainFailed,
  type ConfigTimeError,
  type InfraError,
  type ManifestPersistFailed,
  type RecordingStoreFailed,
} from "./errors.js";

const SEAL_RACE_POLL_MS = 50;
const SEAL_RACE_WAIT_MS = 10_000;

// ---------------------------------------------------------------------------
// Internal seams
// ---------------------------------------------------------------------------

/** Seams the composition root does not expose publicly; tests, the queue, and the drain hold inject here. */
export type RunInternals = {
  readonly makeDrain: (deps: {
    readonly log: EventLog;
    readonly secrets: Secrets;
    readonly storage: ServerStorageAccess;
  }) => Effect.Effect<TranscriptDrain, never, Scope.Scope>;
  /** Substrate seam; hermetic failure paths inject worlds whose apply/revert fail. */
  readonly makeWorld?: typeof makeWorld;
  /** Receiver seam; hermetic tests wrap the real receiver to observe its endpoint or inject stalls. */
  readonly makeReceiver?: typeof makeReceiver;
  /** Engine-topology seam; a hermetic run has no container to reach it, so it answers loopback without asking Docker. */
  readonly resolveBindHost?: typeof resolveReceiverBindHost;
  /** Principal seam; hermetic runs stand in for the wire-speaking out-of-band principal. */
  readonly makePrincipal?: typeof makePrincipal;
  /** Attempt-phase notifications; the in-process queue mirrors them into `AttemptSnapshot`s. */
  readonly onPhase?: (
    phase: "launching" | "running" | "draining" | "sealing",
  ) => Effect.Effect<void, never, never>;
};

export const defaultRunInternals: RunInternals = {
  makeDrain: makeTranscriptDrain,
};

function notifyPhase(
  internals: RunInternals,
  phase: "launching" | "running" | "draining" | "sealing",
): Effect.Effect<void, never, never> {
  return internals.onPhase === undefined
    ? Effect.void
    : internals.onPhase(phase);
}

export type RunOptionsInternal = {
  readonly store?: RecordingStore;
  readonly runner?: Launcher;
  readonly mounts?: Environment;
  readonly allocated?: AllocatedAttempt;
  readonly secrets?: ReadonlyArray<string>;
};

export type SealedAttemptInternal = {
  readonly recording: SealedRecordingRef;
  readonly outcome: RunOutcome;
};

type RunError =
  | ConfigTimeError
  | RecordingStoreFailed
  | ManifestPersistFailed
  | SealFailed;

// ---------------------------------------------------------------------------
// Attempt execution
// ---------------------------------------------------------------------------

type LiveRun = {
  readonly spec: MaterializedRunSpec;
  readonly agentFacing: AgentFacingRunSpec;
  readonly store: RecordingStore;
  readonly secrets: Secrets;
  readonly clock: LogicalClock;
  readonly ref: RecordingRef;
  log?: EventLog;
  receiver?: Receiver;
  drain?: TranscriptDrain;
  society?: Society;
  teardownComplete: boolean;
};

/** The body behind the public `run`; see the file header for the flow. */
export function runAttempt(
  spec: RunSpec,
  options: RunOptionsInternal,
  internals: RunInternals,
): Effect.Effect<SealedAttemptInternal, RunError, Scope.Scope> {
  return Effect.gen(function* () {
    const report = yield* materializeRunSpec(Schema.encodeSync(RunSpec)(spec));
    const store =
      options.store ?? makeLocalRecordingStore(report.spec.recording.storeRoot);
    const identity = new RecordingIdentity({
      specHash: report.specHash,
      seed: report.spec.seed,
    });
    const allocated =
      options.allocated ?? (yield* store.allocateAttempt(identity));
    const secrets = makeSecrets([
      ...(options.secrets ?? []),
      ...mountEnvValues(report.spec),
      ...environmentCredentials(),
    ]);
    const manifest = redactManifest(
      buildManifest(report.spec, report.specHash, allocated),
      secrets,
    );
    const ref = yield* store.persistManifest(manifest);
    const live: LiveRun = {
      spec: report.spec,
      agentFacing: stripCondition(report.spec),
      store,
      secrets,
      clock: elapsedClock(),
      ref,
      teardownComplete: true,
    };
    return yield* executeFromManifest(live, options, internals);
  }).pipe(Effect.withSpan("runAttempt"));
}

/**
 * The agent-facing projection is a real value-level strip, not a type
 * assertion: everything past materialization except manifest persistence
 * receives a spec in which the condition designation does not exist.
 */
const mintAgentFacing = Brand.nominal<MaterializedRunSpec>();

function stripCondition(spec: MaterializedRunSpec): AgentFacingRunSpec {
  const encoded = Schema.encodeSync(RunSpec)(spec);
  const withoutCondition = Object.fromEntries(
    Object.entries(encoded).filter(([key]) => key !== "condition"),
  );
  return mintAgentFacing(Schema.decodeUnknownSync(RunSpec)(withoutCondition));
}

/** The run's logical clock: elapsed integer milliseconds since the manifest persisted. */
function elapsedClock(): LogicalClock {
  const startedAt = Date.now();
  return {
    now: (): LogicalTime =>
      Schema.decodeSync(LogicalTime)(Math.max(0, Date.now() - startedAt)),
  };
}

function mountEnvValues(spec: MaterializedRunSpec): Array<string> {
  return spec.agents.flatMap((agent) =>
    agent.mcpServers.flatMap((server) => Object.values(server.env)),
  );
}

const CREDENTIAL_ENV_NAME = /key|token|secret|password|credential/iu;
const MIN_ENV_CREDENTIAL_LENGTH = 8;

/**
 * Provider keys read from the environment sit inside the credential
 * trust boundary: host-run runtimes inherit this process's environment,
 * so credential-named values register before anything launches. The
 * length floor keeps trivial values ("1", "true") from poisoning
 * redaction.
 */
function environmentCredentials(): Array<string> {
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- the redaction boundary scans the whole ambient environment; a typed config cannot enumerate unknown credential variables
  return Object.entries(process.env).flatMap(([name, value]) =>
    value !== undefined &&
    CREDENTIAL_ENV_NAME.test(name) &&
    value.length >= MIN_ENV_CREDENTIAL_LENGTH
      ? [value]
      : [],
  );
}

/**
 * Post-manifest execution: every path from here lands a recording. The
 * interruptible middle (launch + episode + failure-channel race) is
 * bracketed so cooperative interrupts (SIGINT, cancel) shut down and seal
 * with termination `interrupted` before the interruption propagates.
 */
function executeFromManifest(
  live: LiveRun,
  options: RunOptionsInternal,
  internals: RunInternals,
): Effect.Effect<SealedAttemptInternal, SealFailed, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      live.log = yield* makeEventLog({
        runId: live.ref.runId,
        clock: live.clock,
        sink: {
          appendEvents: (lines) => live.store.appendEvents(live.ref, lines),
        },
        secrets: live.secrets,
      });
      yield* enqueueLifecycle(live, {
        _tag: "run.started",
        specHash: live.ref.identity.specHash,
        seed: live.spec.seed,
      });
      yield* notifyPhase(internals, "launching");
      const outcome = yield* restore(
        raceEpisode(live, options, internals),
      ).pipe(
        Effect.onInterrupt(() =>
          shutdownAndSeal(
            live,
            internals,
            new EpisodeOutcome({ termination: "interrupted" }),
          ).pipe(Effect.ignore),
        ),
      );
      return yield* shutdownAndSeal(live, internals, outcome);
    }),
  );
}

/** Typed infrastructure failures become the sealed outcome; interrupts propagate untouched. */
function raceEpisode(
  live: LiveRun,
  options: RunOptionsInternal,
  internals: RunInternals,
): Effect.Effect<RunOutcome, never, Scope.Scope> {
  return prepareAndRace(live, options, internals).pipe(
    Effect.map(
      (termination) => new EpisodeOutcome({ termination }) as RunOutcome,
    ),
    Effect.catchAll((error) =>
      Effect.succeed<RunOutcome>(infrastructureOutcome(live, error)),
    ),
  );
}

/**
 * Bring-up in the contract order (receiver, world, launch, drain,
 * principal), then one race over the episode and every long-lived
 * failure channel: log sink, OTLP acknowledgment, transcript drain, and
 * each mount's proxy health.
 */
function prepareAndRace(
  live: LiveRun,
  options: RunOptionsInternal,
  internals: RunInternals,
): Effect.Effect<EpisodeTermination, InfraError, Scope.Scope> {
  return Effect.gen(function* () {
    const world = yield* bringUp(live, options, internals);
    // Materialization already validated the driver refs; a failure here
    // is a registry defect, not an expressible run failure.
    const principal = yield* (internals.makePrincipal ?? makePrincipal)(
      live.spec.episode.principalDriver,
      { secrets: live.secrets },
    ).pipe(Effect.orDie);
    yield* notifyPhase(internals, "running");
    // raceAll settles on the first SUCCESS; failure channels fail typed,
    // so each contender races as its Either and the first completion of
    // any kind wins (losers are interrupted).
    const first = yield* Effect.raceAll(
      contendersOf(live, world, principal).map((contender) =>
        Effect.either(contender),
      ),
    );
    return yield* first;
  });
}

/** Receiver, world, launch, and drain in the contract order; the handles land on `live`. */
function bringUp(
  live: LiveRun,
  options: RunOptionsInternal,
  internals: RunInternals,
): Effect.Effect<World, InfraError, Scope.Scope> {
  return Effect.gen(function* () {
    const log = mustLog(live);
    const receiver = yield* (internals.makeReceiver ?? makeReceiver)({
      runId: live.ref.runId,
      log,
      failBoundMs: live.spec.timeouts.otlpReceiverFailMs,
      secrets: live.secrets,
      bindHost: yield* (internals.resolveBindHost ?? resolveReceiverBindHost)(),
    });
    live.receiver = receiver;
    const world = yield* (internals.makeWorld ?? makeWorld)();
    const launcher = options.runner ?? makeLauncher();
    const environment = options.mounts ?? makeEnvironment();
    live.society = yield* launcher.launch(live.agentFacing, {
      environment,
      world,
      log,
      secrets: live.secrets,
      otlpEndpoint: receiver.endpoint,
    });
    live.drain = yield* internals.makeDrain({
      log,
      secrets: live.secrets,
      storage: live.society.server.storage,
    });
    return world;
  });
}

function contendersOf(
  live: LiveRun,
  world: World,
  principal: Principal,
): ReadonlyArray<Effect.Effect<EpisodeTermination, InfraError, never>> {
  const log = mustLog(live);
  const society = live.society;
  const receiver = live.receiver;
  const drain = live.drain;
  if (society === undefined || receiver === undefined || drain === undefined) {
    return [Effect.dieMessage("bringUp left the run partially wired")];
  }
  return [
    episodeRun(live.agentFacing, {
      world: society,
      worldDriver: world,
      log,
      principal,
      clock: live.clock,
    }),
    log.awaitFailure(),
    receiver.awaitFailure(),
    drain.awaitFailure(),
    ...society.mounts.map((mount) => mount.awaitFailure()),
  ];
}

function mustLog(live: LiveRun): EventLog {
  if (live.log === undefined) {
    return Effect.runSync(
      Effect.dieMessage("event log used before construction"),
    );
  }
  return live.log;
}

function infrastructureOutcome(
  live: LiveRun,
  error: InfraError,
): FailureOutcome {
  return new FailureOutcome({
    reason: failureReasonOf(error),
    errorTag: error._tag,
    errorDetail: errorDetailOf(live.secrets, error),
    errorMessage: live.secrets.redact(error.message),
  });
}

/** The error's schema fields (tag and message excluded) become the sealed diagnostic detail, redacted like every recorded value. */
function errorDetailOf(
  secrets: Secrets,
  error: InfraError,
): Record<string, JsonValue> {
  const detail: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key === "_tag" || key === "message") continue;
    const decoded = Schema.decodeUnknownOption(JsonValue)(value);
    if (Option.isSome(decoded)) {
      detail[key] = secrets.redactJson(decoded.value);
    }
  }
  return detail;
}

/**
 * The seal-site exhaustive map from `InfraError` onto the closed
 * taxonomy: the `Record` key type makes a new union member a compile
 * error here until it gets a reason.
 */
const FAILURE_REASON_BY_TAG: Record<InfraError["_tag"], FailureReason> = {
  ServerLaunchFailed: "server-launch-failed",
  AgentLaunchFailed: "agent-launch-failed",
  ProvisioningFailed: "provisioning-failed",
  MountFailed: "mount-failed",
  LoggingProxyFailed: "logging-proxy-failed",
  FaultApplyFailed: "fault-apply-failed",
  FaultRevertFailed: "fault-revert-failed",
  TaskInjectionFailed: "task-injection-failed",
  DriverCrashed: "driver-crashed",
  TraceCaptureFailed: "span-acceptance-lost",
  TranscriptDrainFailed: "transcript-drain-failed",
  RecordingStoreFailed: "recording-store-failed",
};

export function failureReasonOf(error: InfraError): FailureReason {
  return FAILURE_REASON_BY_TAG[error._tag];
}

// ---------------------------------------------------------------------------
// Shutdown and seal
// ---------------------------------------------------------------------------

/**
 * The binding shutdown sequence, verbatim: teardown (server stopped) →
 * final transcript sweep → log seal → trace drain and write → store
 * seal. The sweep runs after the stop because PGlite is single-process
 * (the data directory must not be live-held) and before the log seal so
 * the recording guarantee is unchanged. A shutdown-phase failure
 * downgrades an episode outcome to the corresponding infrastructure
 * failure (the first observed failure wins); an already-failed outcome
 * is preserved.
 */
function shutdownAndSeal(
  live: LiveRun,
  internals: RunInternals,
  initial: RunOutcome,
): Effect.Effect<SealedAttemptInternal, SealFailed, never> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      yield* notifyPhase(internals, "draining");
      const serverStopped = yield* teardownSociety(live);
      // An incomplete teardown means the server container did not
      // confirm its stop (runtime teardown is infallible by contract),
      // so the sweep would read live-held storage; the run seals with
      // the drain's failure reason instead of sweeping.
      let outcome = serverStopped
        ? yield* sweepTranscripts(live, initial)
        : skippedSweepOutcome(live, initial);
      yield* enqueueLifecycle(live, { _tag: "run.terminated" });
      const summary = yield* sealEventLog(live);
      if (summary.failed !== undefined && outcome._tag === "episode") {
        outcome = infrastructureOutcome(live, summary.failed);
      }
      outcome = yield* writeTraces(live, outcome);
      yield* notifyPhase(internals, "sealing");
      const result = new ResultJson({
        recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
        runId: live.ref.runId,
        outcome,
        endedAtWallTime: wallTimeNow(),
        finalLogicalSequence: summary.finalLogicalSequence,
        teardownComplete: live.teardownComplete,
      });
      return yield* sealStore(live, result, outcome);
    }),
  ).pipe(Effect.withSpan("shutdownAndSeal"));
}

/**
 * A final-sweep failure invalidates the transcript evidence, so it
 * downgrades an episode outcome to `transcript-drain-failed`; a run that
 * already failed keeps its first cause.
 */
function sweepTranscripts(
  live: LiveRun,
  outcome: RunOutcome,
): Effect.Effect<RunOutcome, never, never> {
  if (live.drain === undefined) return Effect.succeed(outcome);
  return live.drain.finalSweep().pipe(
    Effect.as(outcome),
    Effect.catchAll((cause) =>
      Effect.succeed(
        outcome._tag === "episode"
          ? infrastructureOutcome(live, cause)
          : outcome,
      ),
    ),
  );
}

/** Returns whether teardown completed (and so the server confirmed its stop). */
function teardownSociety(live: LiveRun): Effect.Effect<boolean, never, never> {
  if (live.society === undefined) return Effect.succeed(true);
  return live.society.teardown().pipe(
    Effect.flatMap((report) => {
      live.teardownComplete = report.complete;
      return enqueueLifecycle(live, {
        _tag: "teardown.completed",
        complete: report.complete,
        failures: report.failures,
      }).pipe(Effect.as(report.complete));
    }),
  );
}

/** The sweep-skipped outcome: transcript evidence is incomplete by the drain's own failure mode; an already-failed outcome keeps its first cause. */
function skippedSweepOutcome(live: LiveRun, outcome: RunOutcome): RunOutcome {
  if (outcome._tag !== "episode") return outcome;
  return infrastructureOutcome(
    live,
    new TranscriptDrainFailed({
      detail:
        "the server teardown reported failures, so the storage volume may still be live-held",
      message:
        "The transcript sweep was skipped: the server container did not confirm its stop, and reading a live-held PGlite volume is unsafe. The run seals failed; message evidence is incomplete.",
    }),
  );
}

type SealLogSummary = {
  readonly finalLogicalSequence: LogicalSequence;
  readonly failed: RecordingStoreFailed | undefined;
};

function sealEventLog(
  live: LiveRun,
): Effect.Effect<SealLogSummary, never, never> {
  if (live.log === undefined) {
    return Effect.succeed({
      finalLogicalSequence: Schema.decodeSync(LogicalSequence)(0),
      failed: undefined,
    });
  }
  return live.log.seal().pipe(
    Effect.map((summary) => ({
      finalLogicalSequence: summary.finalLogicalSequence,
      failed: undefined,
    })),
    Effect.catchAll((cause) =>
      Effect.succeed({
        finalLogicalSequence: Schema.decodeSync(LogicalSequence)(0),
        failed: cause,
      }),
    ),
  );
}

function writeTraces(
  live: LiveRun,
  outcome: RunOutcome,
): Effect.Effect<RunOutcome, never, never> {
  if (live.receiver === undefined) return Effect.succeed(outcome);
  return live.receiver.drainTraces().pipe(
    Effect.tap((traces) =>
      // Zero spans is legal (a run need not export any) but it is also
      // the signature of a receiver the container cannot reach, so the
      // seal is loud about it instead of silent.
      traces.spans.length === 0
        ? Effect.logWarning(
            `run ${live.ref.runId}: no spans were captured; if the server container was expected to export spans, verify OTLP reachability from the container against the address the receiver bound (see resolveReceiverBindHost)`,
          )
        : Effect.void,
    ),
    Effect.flatMap((traces) => live.store.writeTraces(live.ref, traces)),
    Effect.as(outcome),
    Effect.catchAll((cause) =>
      Effect.succeed(
        outcome._tag === "episode"
          ? infrastructureOutcome(live, cause)
          : outcome,
      ),
    ),
  );
}

/**
 * Store-seal with the at-most-once race semantics: `marker-present` reads
 * the winner's single outcome; `lock-held` awaits the in-process winner's
 * marker for a bounded window, then classifies as unsealed (`SealFailed`,
 * the crash-tombstone reading).
 */
function sealStore(
  live: LiveRun,
  result: ResultJson,
  outcome: RunOutcome,
): Effect.Effect<SealedAttemptInternal, SealFailed, never> {
  return live.store.seal(live.ref, result).pipe(
    Effect.map((recording): SealedAttemptInternal => ({ recording, outcome })),
    Effect.catchTag("AlreadySealed", (raced) =>
      raced.observed === "marker-present"
        ? readWinnerOutcome(live)
        : awaitWinnerMarker(live, SEAL_RACE_WAIT_MS),
    ),
  );
}

function sealRaceFailed(path: string, detail: string): SealFailed {
  return new SealFailed({
    recordingPath: path,
    step: "acquire-lock",
    message: `The seal race resolved without a readable sealed outcome: ${detail}. The recording reads as unsealed.`,
  });
}

function readWinnerOutcome(
  live: LiveRun,
): Effect.Effect<SealedAttemptInternal, SealFailed, never> {
  return live.store.read(live.ref.path).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Effect.fail(sealRaceFailed(live.ref.path, cause.message)),
      onSuccess: (snapshot) => {
        const recording = mintSealedFromEvidence(live.ref, snapshot);
        if (recording === undefined || snapshot.result === undefined) {
          return Effect.fail(
            sealRaceFailed(live.ref.path, "marker present but unreadable"),
          );
        }
        return Effect.succeed({ recording, outcome: snapshot.result.outcome });
      },
    }),
  );
}

function awaitWinnerMarker(
  live: LiveRun,
  budgetMs: number,
): Effect.Effect<SealedAttemptInternal, SealFailed, never> {
  if (budgetMs <= 0) {
    return Effect.fail(
      sealRaceFailed(
        live.ref.path,
        "a seal lock exists with no marker and no completing sealer (crash tombstone)",
      ),
    );
  }
  return live.store.read(live.ref.path).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(undefined),
      onSuccess: (snapshot) => Effect.succeed(snapshot.seal),
    }),
    Effect.flatMap((marker) =>
      marker !== undefined
        ? readWinnerOutcome(live)
        : Effect.sleep(`${SEAL_RACE_POLL_MS} millis`).pipe(
            Effect.zipRight(
              awaitWinnerMarker(live, budgetMs - SEAL_RACE_POLL_MS),
            ),
          ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

function enqueueLifecycle(
  live: LiveRun,
  fields:
    | {
        readonly _tag: "run.started";
        readonly specHash: SpecHash;
        readonly seed: MaterializedRunSpec["seed"];
      }
    | { readonly _tag: "run.terminated" }
    | {
        readonly _tag: "teardown.completed";
        readonly complete: boolean;
        readonly failures: ReadonlyArray<string>;
      },
): Effect.Effect<void, never, never> {
  if (live.log === undefined) return Effect.void;
  return live.log
    .enqueue({ ...fields, source: "lifecycle", wallTime: wallTimeNow() })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("EventLogSealed", () => Effect.void),
    );
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const PackageMetadata = Schema.Struct({ version: Schema.String });

function simulatorVersion(): string {
  const metadata = Schema.decodeUnknownSync(PackageMetadata)(
    createRequire(import.meta.url)("../../package.json"),
  );
  return metadata.version;
}

function resolvedPackageVersion(name: string): string {
  const require = createRequire(import.meta.url);
  const metadata = Schema.decodeUnknownSync(PackageMetadata)(
    require(`${name}/package.json`),
  );
  return `${name}@${metadata.version}`;
}

function runtimeVersionOf(
  agent: MaterializedRunSpec["agents"][number],
): string {
  switch (agent.runtime._tag) {
    case "openclaw":
      return resolvedPackageVersion("openclaw");
    case "nanoclaw":
      return `nanoclaw@${NANOCLAW_PINNED_SHA}`;
    case "stub":
      return `stub@${simulatorVersion()}`;
    default: {
      const exhaustive: never = agent.runtime;
      return exhaustive;
    }
  }
}

function slotProvenance(
  agent: MaterializedRunSpec["agents"][number],
): AgentProvenance {
  const modelId =
    agent.runtime._tag === "stub" ? undefined : agent.runtime.config.modelId;
  return new AgentProvenance({
    agent: agent.name,
    runtimeKind: agent.runtime._tag,
    runtimeVersion: runtimeVersionOf(agent),
    ...(modelId === undefined ? {} : { modelId }),
    providerParameters: {},
    isolation: agent.runsIn,
  });
}

function buildManifest(
  spec: MaterializedRunSpec,
  specHash: SpecHash,
  allocated: AllocatedAttempt,
): ManifestJson {
  return new ManifestJson({
    recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
    simulatorVersion: simulatorVersion(),
    runId: allocated.runId,
    attemptId: allocated.attemptId,
    specHash,
    seed: spec.seed,
    ...(spec.contentVersion === undefined
      ? {}
      : { contentVersion: spec.contentVersion }),
    createdAtWallTime: wallTimeNow(),
    serverImageDigest: spec.server.imageDigest,
    slots: spec.agents.map(slotProvenance),
    materializedSpec: spec,
  });
}

/** Redaction applies to the manifest's encoded form before it persists, so the write-time claim holds. */
function redactManifest(
  manifest: ManifestJson,
  secrets: Secrets,
): ManifestJson {
  const encoded = Schema.decodeUnknownSync(JsonValue)(
    Schema.encodeSync(ManifestJson)(manifest),
  );
  return Schema.decodeUnknownSync(ManifestJson)(secrets.redactJson(encoded));
}
