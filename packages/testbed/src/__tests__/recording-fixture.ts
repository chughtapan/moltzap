/**
 * @file Builds real sealed recordings on disk for the grading tests.
 *
 * It writes through the actual `RecordingStore`, so the fixtures satisfy
 * the same seal protocol, digests, and canonical byte encoding a run
 * produces. A hand-rolled directory would only prove the grader agrees
 * with the fixture builder.
 */
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import {
  AgentProvenance,
  EpisodeOutcome,
  LogicalSequence,
  ManifestJson,
  RECORDING_SCHEMA_VERSION,
  RecordingIdentity,
  ResultJson,
  RunSpec,
  TracesJson,
  WallTimeMs,
  computeSpecHash,
  makeLocalRecordingStore,
  materializeRunSpec,
  type AllocatedAttempt,
  type RecordingStore,
  type RunOutcome,
} from "../simulator/index.js";
import { specInput } from "../simulator/__tests__/support.js";

export const AGENT_ID_ONE = "agent-id-one";
export const AGENT_ID_TWO = "agent-id-two";
export const AGENT_ONE = "agent-one";
export const AGENT_TWO = "agent-two";
export const CONVERSATION = "conv-1";
const EPISODE = "e1";
const SPOKEN_CONTENT = "spoken";
export const FIXTURE_RUN_ID = "aaaaaaaaaaaa-s7-a1";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;

const CREATED_AT = 1_700_000_000_000;
const ENDED_AT = 1_700_000_001_000;

export type FixtureOptions = {
  readonly storeRoot: string;
  readonly outcome?: RunOutcome;
  readonly condition?: string;
  /** Event lines to write verbatim, replacing the default transcript. */
  readonly events?: ReadonlyArray<Record<string, unknown>>;
  /** Per-slot provenance the manifest pins; empty unless a case needs it. */
  readonly slots?: ReadonlyArray<AgentProvenance>;
  /** Skip the seal step, leaving the recording unsealed. */
  readonly unsealed?: boolean;
};

/** One host-isolated stub slot, the shape most cases want. */
export function slot(agent: string, modelId?: string): AgentProvenance {
  return new AgentProvenance({
    agent,
    runtimeKind: "stub",
    runtimeVersion: "0.0.0-test",
    isolation: "host",
    ...(modelId === undefined ? {} : { modelId }),
  });
}

export type Fixture = {
  readonly path: string;
  readonly store: RecordingStore;
};

type Fs = FileSystem.FileSystem;

const withFs = <A, E>(
  body: (fs: Fs) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.flatMap(FileSystem.FileSystem, body).pipe(
    Effect.provide(NodeContext.layer),
  );

/** A temp directory usable as a store root. */
export function tempStoreRoot(): Effect.Effect<string, never, never> {
  return withFs((fs) => fs.makeTempDirectory({ prefix: "grader-" })).pipe(
    Effect.orDie,
  );
}

const completedOutcome: RunOutcome = new EpisodeOutcome({
  termination: "completed",
});

function envelope(
  runId: string,
  logicalSequence: number,
  rest: Record<string, unknown>,
): Record<string, unknown> {
  return {
    runId,
    logicalSequence,
    logicalTime: logicalSequence,
    wallTime: CREATED_AT + logicalSequence,
    ...rest,
  };
}

/** A ready-agent event, the left side of the sender-attribution join. */
export function ready(
  runId: string,
  logicalSequence: number,
  agent: string,
  agentId: string,
): Record<string, unknown> {
  return envelope(runId, logicalSequence, {
    _tag: "agent.ready",
    source: "lifecycle",
    agent,
    agentId,
  });
}

export type SpokenStep = {
  readonly runId: string;
  readonly logicalSequence: number;
  readonly principal: string;
  /** The message the speech produced; the right side of the principal join. */
  readonly messageId: string;
  readonly conversationId?: string;
};

/** A recorded speech step, the only place a principal's name is written down. */
export function spoken(step: SpokenStep): Record<string, unknown> {
  const conversationId = step.conversationId ?? CONVERSATION;
  return envelope(step.runId, step.logicalSequence, {
    _tag: "step.spoken",
    source: "scheduler",
    episodeId: EPISODE,
    principal: step.principal,
    content: SPOKEN_CONTENT,
    taskId: `task-${conversationId}`,
    conversationId,
    messageId: step.messageId,
  });
}

export type TranscriptRow = {
  readonly runId: string;
  readonly logicalSequence: number;
  readonly senderId: string;
  readonly conversationSeq: number;
  readonly text: string;
  readonly conversationId?: string;
  /** Replaces the single text part, for bodies that carry no readable text. */
  readonly parts?: ReadonlyArray<Record<string, unknown>>;
  /** Wire message identity; name it when a `step.spoken` has to match it. */
  readonly messageId?: string;
};

/** Message ids are unique across the whole log, so the default keys on the sequence. */
function defaultMessageId(logicalSequence: number): string {
  return `m${String(logicalSequence)}`;
}

export function transcript(row: TranscriptRow): Record<string, unknown> {
  return envelope(row.runId, row.logicalSequence, {
    _tag: "transcript.message",
    source: "transcript",
    conversationId: row.conversationId ?? CONVERSATION,
    conversationSeq: row.conversationSeq,
    senderId: row.senderId,
    message: {
      id: row.messageId ?? defaultMessageId(row.logicalSequence),
      parts: row.parts ?? [{ type: "text", text: row.text }],
    },
    createdAtWallTime: CREATED_AT + row.logicalSequence,
  });
}

/** The default transcript: two ready slots, one message each. */
function defaultEvents(runId: string): ReadonlyArray<Record<string, unknown>> {
  return [
    envelope(runId, 1, {
      _tag: "run.started",
      source: "lifecycle",
      specHash: "0".repeat(64),
      seed: 7,
    }),
    ready(runId, 2, AGENT_ONE, AGENT_ID_ONE),
    ready(runId, 3, AGENT_TWO, AGENT_ID_TWO),
    transcript({
      runId,
      logicalSequence: 4,
      senderId: AGENT_ID_ONE,
      conversationSeq: 1,
      text: "hello",
    }),
    transcript({
      runId,
      logicalSequence: 5,
      senderId: AGENT_ID_TWO,
      conversationSeq: 2,
      text: "hi back",
    }),
  ];
}

export const DEFAULT_EVENT_COUNT = 5;

function buildManifest(
  allocated: AllocatedAttempt,
  spec: RunSpec,
  slots: ReadonlyArray<AgentProvenance>,
): ManifestJson {
  return new ManifestJson({
    recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
    simulatorVersion: "0.0.0-test",
    runId: allocated.runId,
    attemptId: allocated.attemptId,
    specHash: allocated.identity.specHash,
    seed: allocated.identity.seed,
    createdAtWallTime: Schema.decodeSync(WallTimeMs)(CREATED_AT),
    serverImageDigest: IMAGE_DIGEST,
    slots,
    materializedSpec: Schema.decodeSync(RunSpec)(
      Schema.encodeSync(RunSpec)(spec),
    ),
  });
}

function buildResult(
  allocated: AllocatedAttempt,
  outcome: RunOutcome,
  eventCount: number,
): ResultJson {
  return new ResultJson({
    recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
    runId: allocated.runId,
    outcome,
    endedAtWallTime: Schema.decodeSync(WallTimeMs)(ENDED_AT),
    finalLogicalSequence: Schema.decodeSync(LogicalSequence)(eventCount),
    teardownComplete: true,
  });
}

/** Write one recording and, unless asked otherwise, seal it. */
export function makeRecording(
  options: FixtureOptions,
): Effect.Effect<Fixture, never, never> {
  return Effect.gen(function* () {
    const store = makeLocalRecordingStore(options.storeRoot);
    const report = yield* materializeRunSpec(
      specInput(
        options.storeRoot,
        options.condition === undefined
          ? {}
          : { condition: { label: options.condition } },
      ),
    );
    const allocated = yield* store.allocateAttempt(
      new RecordingIdentity({
        specHash: computeSpecHash(report.spec),
        seed: report.spec.seed,
      }),
    );
    const ref = yield* store.persistManifest(
      buildManifest(allocated, report.spec, options.slots ?? []),
    );
    const lines = (options.events ?? defaultEvents(allocated.runId)).map(
      (event) => JSON.stringify(event),
    );
    yield* store.appendEvents(ref, lines);
    yield* store.writeTraces(
      ref,
      new TracesJson({
        recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
        runId: allocated.runId,
        spans: [],
      }),
    );
    if (options.unsealed !== true) {
      yield* store.seal(
        ref,
        buildResult(
          allocated,
          options.outcome ?? completedOutcome,
          lines.length,
        ),
      );
    }
    return { path: ref.path, store };
  }).pipe(Effect.orDie, Effect.withSpan("makeRecording"));
}

/** Corrupt a sealed file so its digest no longer matches the marker. */
export function tamper(
  path: string,
  file: string,
): Effect.Effect<void, never, never> {
  return withFs((fs) => fs.writeFileString(join(path, file), "{}\n")).pipe(
    Effect.orDie,
  );
}
