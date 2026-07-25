/**
 * @file The recording-backed cc-judge binding: a dist file beside
 * `trace-capture-harness.ts`, deliberately not an export-map entry.
 *
 * cc-judge's loaded-plan contract is `load(args)` returning a plan, a
 * harness, and a coordinator, where the harness runs for effect only and
 * a custom coordinator produces the judgment bundle. The online adapter already
 * uses that shape; this one differs only in where the evidence comes
 * from — a sealed directory instead of a live server — so the harness is
 * inert and the coordinator does all the work.
 *
 * The bundle mapping is this file's own. `buildTraceBundle` cannot serve
 * it: its inputs are a live payload, runtime timestamps, and synthesized
 * outcomes, none of which a recording has or should invent.
 *
 * Outcome policy is binary because cc-judge's pipeline is binary. On
 * coordinator success the bundle is judged; on failure a deterministic
 * failed record is emitted and nothing is judged. There is no
 * judged-but-flagged middle, so a run that never completed is refused
 * here rather than scored — and under the shipped recipe it never gets
 * this far, because preflight refuses it at exit 14 first.
 */
import { Data, Effect } from "effect";
import {
  openRecording,
  type GradeableRecording,
  type JsonValue,
} from "./grader.js";

/** Placeholder image for slots the coordinator never launches. */
const PLACEHOLDER_IMAGE = "managed/by-moltzap-recording";

type PlanEnvelope = {
  readonly project: string;
  readonly scenarioId: string;
  readonly name: string;
  readonly description: string;
  readonly requirements: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

type HarnessLoadArgs = {
  readonly sourcePath: string;
  readonly plan: PlanEnvelope;
  readonly payload: unknown;
};

/** cc-judge folds a coordinator failure into a deterministic failed record. */
class RunCoordinationError extends Data.TaggedError("RunCoordinationError")<{
  readonly message: string;
}> {}

type HarnessFailure = { readonly cause: RunCoordinationError };

function coordinationFailure(message: string): HarnessFailure {
  return { cause: new RunCoordinationError({ message }) };
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

type RecordingPayload = {
  readonly recording: string;
  readonly condition: string | null;
};

function decodePayload(
  sourcePath: string,
  payload: unknown,
): Effect.Effect<RecordingPayload, HarnessFailure, never> {
  if (typeof payload !== "object" || payload === null) {
    return Effect.fail(
      coordinationFailure(
        `${sourcePath}: harness.payload must be an object carrying { recording }.`,
      ),
    );
  }
  const recording = "recording" in payload ? payload.recording : undefined;
  if (typeof recording !== "string" || recording.length === 0) {
    return Effect.fail(
      coordinationFailure(
        `${sourcePath}: harness.payload.recording must be the path of a sealed recording directory.`,
      ),
    );
  }
  const condition =
    "condition" in payload && typeof payload.condition === "string"
      ? payload.condition
      : null;
  return Effect.succeed({ recording, condition });
}

// ---------------------------------------------------------------------------
// Judgment bundle
// ---------------------------------------------------------------------------

/** One message as the judge reads it. */
type BundleMessage = {
  readonly logicalSequence: number;
  readonly conversationId: string;
  readonly conversationSeq: number;
  readonly senderId: string;
  readonly sender: string;
  readonly createdAtWallTime: number;
  readonly message: JsonValue;
};

function transcriptOf(
  recording: GradeableRecording,
): ReadonlyArray<BundleMessage> {
  const messages: Array<BundleMessage> = [];
  for (const event of recording.timeline) {
    if (event._tag !== "transcript.message") continue;
    messages.push({
      logicalSequence: event.logicalSequence,
      conversationId: event.conversationId,
      conversationSeq: event.conversationSeq,
      senderId: event.senderId,
      sender: recording.senders.get(event.senderId) ?? event.senderId,
      createdAtWallTime: event.createdAtWallTime,
      message: event.message,
    });
  }
  return messages;
}

function buildBundle(
  plan: PlanEnvelope,
  recording: GradeableRecording,
): Readonly<Record<string, unknown>> {
  return {
    project: plan.project,
    scenarioId: plan.scenarioId,
    name: plan.name,
    description: plan.description,
    requirements: plan.requirements,
    recording: {
      path: recording.path,
      runId: recording.manifest.runId,
      specHash: recording.manifest.specHash,
      seed: recording.manifest.seed,
      attemptId: recording.manifest.attemptId,
      condition: recording.manifest.materializedSpec.condition?.label ?? null,
      outcome: recording.result.outcome,
    },
    agents: recording.manifest.slots.map((slot) => ({
      id: slot.agent,
      name: slot.agent,
      runtimeKind: slot.runtimeKind,
      modelId: slot.modelId ?? null,
      isolation: slot.isolation,
    })),
    transcript: transcriptOf(recording),
    events: recording.timeline.length,
  };
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

function executeRecordingRun(
  plan: PlanEnvelope,
  payload: RecordingPayload,
): Effect.Effect<Readonly<Record<string, unknown>>, HarnessFailure, never> {
  return openRecording(payload.recording, {
    condition: payload.condition,
    outcome: "completed-only",
  }).pipe(
    Effect.map((recording) => buildBundle(plan, recording)),
    Effect.mapError((error) =>
      coordinationFailure(
        error._tag === "RunNotCompleted"
          ? `${error.message} Preflight (exit 14) is where this check belongs; the recipe refuses such a recording before cc-judge starts.`
          : error.message,
      ),
    ),
  );
}

function createCoordinator(payload: RecordingPayload) {
  return {
    execute(
      plan: PlanEnvelope,
    ): Effect.Effect<Readonly<Record<string, unknown>>, HarnessFailure, never> {
      return executeRecordingRun(plan, payload);
    },
  };
}

function buildPlan(args: HarnessLoadArgs, recordingPath: string) {
  return {
    project: args.plan.project,
    scenarioId: args.plan.scenarioId,
    name: args.plan.name,
    description: args.plan.description,
    agents: [
      {
        id: "recording",
        name: "recording",
        role: "target",
        artifact: {
          _tag: "DockerImageArtifact",
          image: PLACEHOLDER_IMAGE,
          pullPolicy: "never",
        },
        promptInputs: {},
      },
    ],
    requirements: args.plan.requirements,
    metadata: {
      ...args.plan.metadata,
      harness: "moltzap-recording",
      recording: recordingPath,
    },
  };
}

const recordingHarness = {
  load(args: HarnessLoadArgs) {
    return decodePayload(args.sourcePath, args.payload).pipe(
      Effect.map((payload) => ({
        plan: buildPlan(args, payload.recording),
        harness: {
          name: "moltzap-recording",
          run: () =>
            Effect.fail(
              coordinationFailure(
                "Recording-backed plans grade through the custom coordinator; the harness executes nothing.",
              ),
            ),
        },
        coordinator: createCoordinator(payload),
      })),
    );
  },
};

export default recordingHarness;
