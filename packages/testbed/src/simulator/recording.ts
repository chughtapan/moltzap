/**
 * @file Recording (contract 5, recording half): typed schemas for the
 * four recording files, the sealing protocol, the RecordingStore seam,
 * and the secret-redaction boundary.
 *
 * A recording is exactly one directory holding `manifest.json`,
 * `events.ndjson`, `traces.json`, `result.json`, and — iff sealed — the
 * atomic completeness marker `sealed.json`. The manifest persists before
 * server bring-up, so every launch failure yields a recording. Sealed
 * means: marker present, and the marker's digests match the other four
 * files. Unsealed means: no marker; readable for diagnosis, never
 * mistaken for absent or complete.
 *
 * Sealing is durably at-most-once per attempt: (1) create `seal.lock`
 * with O_CREAT|O_EXCL, then fsync the directory so the lock's entry
 * survives a crash — the losing racer in a cancel/completion race fails
 * typed with `AlreadySealed` (`observed: "marker-present"` = winner
 * sealed, read its outcome; `observed: "lock-held"` = winner mid-seal or
 * crash tombstone, no sealed outcome yet) and never writes; (2) fsync the three
 * pre-result files (`manifest.json`, `events.ndjson`, `traces.json`);
 * (3) write `result.json` and fsync; (4) write `sealed.json.tmp`, fsync,
 * atomically rename to `sealed.json`, fsync the directory. A lock with
 * no marker after a crash reads as unsealed (the lock is a tombstone,
 * not a seal). Observed storage failures on non-seal writes (event
 * append, traces write) still seal, with reason `recording-store-failed`;
 * failures of the seal path itself (`SealFailed.step` names which step)
 * necessarily leave an unsealed recording. Abrupt termination the process
 * cannot observe always leaves an unsealed recording.
 */
import { join } from "node:path";
import { Schema, type Brand, type Effect } from "effect";
import { AttemptId, RunId, WallTimeMs, LogicalSequence } from "./ids.js";
import {
  RunsIn,
  JsonValue,
  RunSpec,
  Seed,
  RuntimeKind,
  SpecHash,
} from "./run-spec.js";
import type {
  ManifestPersistFailed,
  RecordingInvalid,
  RecordingSchemaMismatch,
  RecordingStoreFailed,
  SealFailed,
  AlreadySealed,
} from "./errors.js";

/** Integer recording-schema version; bumped on breaking change; graders hard-fail on mismatch. */
export const RECORDING_SCHEMA_VERSION = 1;

/**
 * Version pin every versioned recording file carries; this reader's
 * schemas decode exactly this version. `events.ndjson` lines are
 * unversioned; the manifest governs them and the marker digests bind
 * them. Graders raise `RecordingSchemaMismatch` on any other integer
 * before full decode.
 */
const RecordingSchemaVersion = Schema.Literal(RECORDING_SCHEMA_VERSION);

// ---------------------------------------------------------------------------
// Recording identity
// ---------------------------------------------------------------------------

/** A recording's identity: (spec-hash, seed); attempts multiply under one identity. */
export class RecordingIdentity extends Schema.Class<RecordingIdentity>(
  "RecordingIdentity",
)({
  specHash: SpecHash,
  seed: Seed,
}) {}

// ---------------------------------------------------------------------------
// manifest.json
// ---------------------------------------------------------------------------

/** Per-agent provenance the manifest pins (no credential material, ever). */
export class AgentProvenance extends Schema.Class<AgentProvenance>(
  "AgentProvenance",
)({
  agent: Schema.String.annotations({ description: "Agent name" }),
  runtimeKind: RuntimeKind,
  runtimeVersion: Schema.String.annotations({
    description: "Resolved runtime/adapter version",
  }),
  modelId: Schema.optional(
    Schema.String.annotations({
      description: "Model identifier, by name only",
    }),
  ),
  providerParameters: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: JsonValue }).annotations({
      description: "Provider parameters by name and value, never key material",
    }),
    { default: () => ({}) },
  ),
  imageDigest: Schema.optional(
    Schema.String.annotations({
      description: "Container image digest for container-isolated slots",
    }),
  ),
  isolation: RunsIn,
  promptHash: Schema.optional(
    Schema.String.annotations({
      description: "Consumer-supplied prompt/persona hash",
    }),
  ),
}) {}

/**
 * Run provenance, persisted before server bring-up. Identity-bearing
 * fields are required and never defaulted; the manifest carries the fully
 * materialized spec, never raw user input.
 */
export class ManifestJson extends Schema.Class<ManifestJson>("ManifestJson")({
  recordingSchemaVersion: RecordingSchemaVersion.annotations({
    description: "Schema compatibility gate; graders hard-fail on mismatch",
  }),
  simulatorVersion: Schema.String.annotations({
    description: "Published @moltzap/testbed version",
  }),
  runId: RunId,
  attemptId: AttemptId,
  specHash: SpecHash,
  seed: Seed,
  createdAtWallTime: WallTimeMs,
  gitRevision: Schema.optional(
    Schema.String.annotations({
      description: "Git revision of the invoking workspace, when resolvable",
    }),
  ),
  serverImageDigest: Schema.String.annotations({
    description: "Pinned server container image digest",
  }),
  slots: Schema.Array(AgentProvenance).annotations({
    description: "Per-slot provenance",
  }),
  lockfileHash: Schema.optional(
    Schema.String.annotations({
      description: "Hash of the resolved lockfile state, when resolvable",
    }),
  ),
  materializedSpec: RunSpec.annotations({
    description:
      "The fully materialized spec, defaults resolved, redaction policy applied",
  }),
}) {}

// ---------------------------------------------------------------------------
// result.json
// ---------------------------------------------------------------------------

/** Episode terminations (cooperative paths; every one seals). */
export const EpisodeTermination = Schema.Literal(
  "completed",
  "agent-crashed",
  "timeout",
  "interrupted",
).annotations({ description: "How the episode ended" });
export type EpisodeTermination = typeof EpisodeTermination.Type;

/**
 * Closed taxonomy of infrastructure failures that end a run before an
 * episode outcome exists, observed by a process that can still seal.
 * Worker death is deliberately absent: a dead worker seals nothing; that
 * outcome is a finished attempt with `workerLost: true` and an unsealed
 * recording.
 */
export const FailureReason = Schema.Literal(
  "server-launch-failed",
  "agent-launch-failed",
  "provisioning-failed",
  "mount-failed",
  "logging-proxy-failed",
  "span-acceptance-lost",
  "transcript-drain-failed",
  "fault-apply-failed",
  "fault-revert-failed",
  "task-injection-failed",
  "driver-crashed",
  "recording-store-failed",
).annotations({ description: "Why infrastructure ended the run; closed set" });
export type FailureReason = typeof FailureReason.Type;

/** The run reached an episode outcome. */
export class EpisodeOutcome extends Schema.TaggedClass<EpisodeOutcome>()(
  "episode",
  {
    termination: EpisodeTermination,
  },
) {}

/** Infrastructure ended the run; the causing tagged error is serialized alongside the reason. */
export class FailureOutcome extends Schema.TaggedClass<FailureOutcome>()(
  "infrastructure-failure",
  {
    reason: FailureReason,
    errorTag: Schema.String.annotations({
      description: "Stable _tag of the causing error",
    }),
    errorDetail: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: JsonValue }).annotations({
        description:
          "The causing error's own fields (slot, driver name, ...), redaction applied",
      }),
      { default: () => ({}) },
    ),
    errorMessage: Schema.String.annotations({
      description: "Problem, cause, fix",
    }),
  },
) {}

/** Exactly one outcome per sealed attempt; cancellation racing completion resolves to the single sealed outcome. */
const RunOutcome = Schema.Union(EpisodeOutcome, FailureOutcome);
export type RunOutcome = typeof RunOutcome.Type;

/** Outcome and termination evidence; written by the seal path only. */
export class ResultJson extends Schema.Class<ResultJson>("ResultJson")({
  recordingSchemaVersion: RecordingSchemaVersion,
  runId: RunId,
  outcome: RunOutcome,
  endedAtWallTime: WallTimeMs,
  finalLogicalSequence: LogicalSequence.annotations({
    description: "Sequence of the last drained event",
  }),
  teardownComplete: Schema.Boolean.annotations({
    description:
      "False when reverse teardown could not fully reverse; details are evented",
  }),
}) {}

// ---------------------------------------------------------------------------
// traces.json
// ---------------------------------------------------------------------------

/** One accepted span; `raw` is the verbatim OTLP export (unknown kinds preserved). */
export class CapturedSpan extends Schema.Class<CapturedSpan>("CapturedSpan")({
  acceptedAtWallTime: WallTimeMs,
  logicalSequence: LogicalSequence.annotations({
    description: "Sequence of the paired span.accepted event",
  }),
  raw: JsonValue.annotations({ description: "Verbatim OTLP span JSON" }),
}) {}

/** All spans accepted before seal; span completeness upstream of acceptance is not claimed. */
export class TracesJson extends Schema.Class<TracesJson>("TracesJson")({
  recordingSchemaVersion: RecordingSchemaVersion,
  runId: RunId,
  spans: Schema.Array(CapturedSpan),
}) {}

// ---------------------------------------------------------------------------
// sealed.json (atomic completeness marker)
// ---------------------------------------------------------------------------

/** sha256 hex digest. */
export const Sha256 = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{64}$/),
  Schema.annotations({ description: "sha256 hex digest" }),
);

/**
 * The completeness marker. Present iff the recording is sealed; its
 * digests make "complete and mutually consistent" checkable offline.
 */
export class SealMarker extends Schema.Class<SealMarker>("SealMarker")({
  recordingSchemaVersion: RecordingSchemaVersion,
  runId: RunId,
  sealedAtWallTime: WallTimeMs,
  files: Schema.Struct({
    "manifest.json": Sha256,
    "events.ndjson": Sha256,
    "traces.json": Sha256,
    "result.json": Sha256,
  }).annotations({ description: "Digests of the four sealed files" }),
}) {}

// ---------------------------------------------------------------------------
// Store seam
// ---------------------------------------------------------------------------

/** Unsealed recording location under a store. */
export type RecordingRef = {
  readonly identity: RecordingIdentity;
  readonly attemptId: AttemptId;
  readonly runId: RunId;
  /** `{storeRoot}/{specHash}/s{seed}/{attemptId}/` */
  readonly path: string;
};

/** A ref that has been sealed; only `RecordingStore.seal` mints it. */
export type SealedRecordingRef = RecordingRef &
  Brand.Brand<"SealedRecordingRef">;

/**
 * Decoded view of a recording on disk, sealed or not. Event lines are
 * JSON values; graders decode them per line via `decodeEventLine` (the
 * event union lives in `event-log.ts`; typing them here would cycle the
 * modules).
 */
export type RecordingSnapshot = {
  readonly manifest: ManifestJson;
  readonly events: ReadonlyArray<JsonValue>;
  readonly traces: TracesJson | undefined;
  readonly result: ResultJson | undefined;
  readonly seal: SealMarker | undefined;
};

/** A store-allocated attempt: the ids one attempt executes under. */
export type AllocatedAttempt = {
  readonly identity: RecordingIdentity;
  readonly attemptId: AttemptId;
  readonly runId: RunId;
};

/**
 * RecordingStore seam: durable persistence for recordings, addressable
 * per attempt so concurrent runs share one store. v0 ships a local
 * filesystem implementation; the seam exists so remote stores can land
 * without surface change. Sealed attempts are never overwritten. The
 * store is also the attempt allocator: `allocateAttempt` is the one
 * atomic source of attempt ids, shared by `run` standalone and by
 * the queue's workers, so both follow the same identity protocol.
 */
export interface RecordingStore {
  /** Atomically allocate the next attempt id (and its runId) under one identity. */
  allocateAttempt(
    identity: RecordingIdentity,
  ): Effect.Effect<AllocatedAttempt, RecordingStoreFailed, never>;

  /** Create the recording directory and persist the manifest; the run begins here. */
  persistManifest(
    manifest: ManifestJson,
  ): Effect.Effect<RecordingRef, ManifestPersistFailed, never>;

  /** Append drained event lines to one attempt's `events.ndjson`. */
  appendEvents(
    ref: RecordingRef,
    lines: ReadonlyArray<string>,
  ): Effect.Effect<void, RecordingStoreFailed, never>;

  /** Write one attempt's accepted-span file. */
  writeTraces(
    ref: RecordingRef,
    traces: TracesJson,
  ): Effect.Effect<void, RecordingStoreFailed, never>;

  /** The seal path (lock, fsync, result, marker; file-header protocol). Durably at most once per attempt; a lost race fails typed. */
  seal(
    ref: RecordingRef,
    result: ResultJson,
  ): Effect.Effect<SealedRecordingRef, SealFailed | AlreadySealed, never>;

  /** Read any recording back; version mismatch and schema-invalid files surface typed. */
  read(
    path: string,
  ): Effect.Effect<
    RecordingSnapshot,
    RecordingStoreFailed | RecordingInvalid | RecordingSchemaMismatch,
    never
  >;
}

/**
 * Compute the recording path for one attempt:
 * `{storeRoot}/{specHash}/s{seed}/{attemptId}`. Injective because every
 * component is path-safe by schema (hex hash, integer seed, `a{n}`) and
 * each occupies its own segment.
 */
export function recordingPath(
  storeRoot: string,
  identity: RecordingIdentity,
  attemptId: AttemptId,
): string {
  return join(
    storeRoot,
    identity.specHash,
    `s${String(identity.seed)}`,
    attemptId,
  );
}

// ---------------------------------------------------------------------------
// Secret redaction boundary
// ---------------------------------------------------------------------------

/**
 * The trust boundary of invariant 23: credential material is every value
 * the simulator itself holds or injects — agent API keys, provider keys
 * read from the environment for runtimes, the observer credential,
 * registry credentials, and values consumers explicitly register. "Full
 * message content" means full content after replacing every occurrence
 * of a registered secret with `[REDACTED:kN]` (N indexes the registered
 * set in registration order). Hygiene wins over
 * fidelity; strings the simulator never held are outside the boundary
 * and recorded verbatim. Both sides of "drained content matches sent
 * messages" are compared under this same function.
 */
export interface Secrets {
  /** Register one credential value; idempotent per value. */
  register(value: string): void;
  /** Replace registered secrets (and their base64/url encodings) in one string. */
  redact(text: string): string;
  /** Recursively redact every string inside a JSON value (events, spans, tool payloads, configs). */
  redactJson(value: JsonValue): JsonValue;
}

/**
 * Create one attempt's secret registry, seeded with the credentials the
 * simulator already holds at creation (provider keys read from env,
 * registry credentials); launch-time provisioning registers each minted
 * agent key and the observer credential before any process spawns. One
 * registry per attempt — a process-global registry would leak secrets
 * across concurrent runs.
 */
export function makeSecrets(initial: ReadonlyArray<string>): Secrets {
  const state: SecretsState = {
    count: 0,
    seen: new Set(),
    variantIndex: new Map(),
    pattern: null,
  };
  const redact = (text: string): string => redactWith(state, text);
  const secrets: Secrets = {
    register: (value) => {
      registerSecret(state, value);
    },
    redact,
    redactJson: (value) => redactJsonWith(redact, value),
  };
  initial.forEach(secrets.register);
  return secrets;
}

type SecretsState = {
  count: number;
  readonly seen: Set<string>;
  readonly variantIndex: Map<string, number>;
  pattern: RegExp | null;
};

const REDACTION_MARKER = /\[REDACTED:k\d+\]/gu;

function registerSecret(state: SecretsState, value: string): void {
  if (value.length === 0 || state.seen.has(value)) return;
  state.seen.add(value);
  const index = state.count;
  state.count += 1;
  for (const variant of secretVariants(value)) {
    if (!state.variantIndex.has(variant)) {
      state.variantIndex.set(variant, index);
    }
  }
  state.pattern = null;
}

/**
 * Longest-first alternation so an encoding variant that contains another
 * registered value redacts as itself, in one pass over the input.
 */
function matcherFor(state: SecretsState): RegExp | null {
  if (state.variantIndex.size === 0) return null;
  if (state.pattern === null) {
    const variants = [...state.variantIndex.keys()].sort(
      (left, right) => right.length - left.length,
    );
    state.pattern = new RegExp(variants.map(escapeRegExp).join("|"), "gu");
  }
  state.pattern.lastIndex = 0;
  return state.pattern;
}

function redactSegment(state: SecretsState, segment: string): string {
  const regex = matcherFor(state);
  if (regex === null) return segment;
  return segment.replace(regex, (match) => {
    const index = state.variantIndex.get(match);
    return index === undefined ? match : `[REDACTED:k${String(index)}]`;
  });
}

/**
 * Existing redaction markers are never rewritten, so redact is a
 * fixpoint: a second pass sees only marker segments and clean text.
 */
function redactWith(state: SecretsState, text: string): string {
  const segments = text.split(REDACTION_MARKER);
  const markers = text.match(REDACTION_MARKER) ?? [];
  let output = "";
  segments.forEach((segment, index) => {
    output += redactSegment(state, segment);
    const marker = markers[index];
    if (marker !== undefined) output += marker;
  });
  return output;
}

function redactJsonWith(
  redact: (text: string) => string,
  value: JsonValue,
): JsonValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonWith(redact, entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactJsonWith(redact, entry),
      ]),
    );
  }
  return value;
}

function secretVariants(value: string): ReadonlyArray<string> {
  const variants = new Set<string>([value]);
  variants.add(Buffer.from(value, "utf8").toString("base64"));
  variants.add(Buffer.from(value, "utf8").toString("base64url"));
  variants.add(encodeURIComponent(value));
  return [...variants];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
