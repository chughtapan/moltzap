/**
 * @file The cc-judge compat adapter: the entry point cc-judge loads from
 * `dist/trace-capture-harness.js`, unchanged in shape (`load(args)`
 * returning a plan, a harness, and a coordinator), executing on the
 * simulator. A scenario's harness payload becomes a `RunSpec`, `run`
 * produces a sealed recording, and the bundle cc-judge grades is
 * projected from that recording's events — so capture is the recording's
 * job rather than this file's.
 *
 * The scenario file and cc-judge's loader stay byte-unchanged; that
 * compatibility is coverage path 24a.
 */
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Data, Effect, Schema } from "effect";
import type { RuntimeKind } from "./testbed.js";
import {
  decodePayload,
  InvalidPayload,
  type HarnessPayload,
} from "./trace-capture-payload.js";
import {
  buildTraceBundle,
  projectRecordedConversation,
  RecordingUnattributable,
  type RecordedConversation,
} from "./trace-capture-bundle.js";
import {
  decodeEventLine,
  run,
  RunSpec,
  type SealedAttempt,
  type SimulatorEvent,
} from "./simulator/index.js";
import { resolveServerImagePin } from "./simulator/run-config.js";

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const PLAN_TARGET_AGENT_ID = "target-agent";
const PLACEHOLDER_IMAGE = "managed/by-moltzap-trace-capture";
const PRINCIPAL_NAME = "eval-sender";
const DELIVERED_SPAN = "moltzap.message.delivered";
/** The injection delivered to the target, then the target's answer delivered back. */
const EXCHANGE_SPAN_COUNT = 2;

class ExecutionFailed extends Data.TaggedError("ExecutionFailed")<{
  readonly message: string;
}> {}

class HarnessFailed extends Data.TaggedError("HarnessFailed")<{
  readonly detail: ExecutionFailed;
}> {}

type HarnessFailureCause = InvalidPayload | HarnessFailed;

interface HarnessFailure {
  readonly cause: HarnessFailureCause;
}

interface HarnessLoadArgs {
  readonly sourcePath: string;
  readonly plan: {
    readonly project: string;
    readonly scenarioId: string;
    readonly name: string;
    readonly description: string;
    readonly requirements: Readonly<Record<string, unknown>>;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  readonly payload: unknown;
}

function failHarness(message: string): HarnessFailure {
  return {
    cause: new HarnessFailed({ detail: new ExecutionFailed({ message }) }),
  };
}

function defaultTargetAgentName(kind: RuntimeKind): string {
  switch (kind) {
    case "openclaw":
      return "openclaw-eval-agent";
    case "nanoclaw":
      return "nanoclaw-eval-agent";
  }
}

function targetAgentName(payload: HarnessPayload): string {
  return (
    payload.runtime.targetAgentName ??
    defaultTargetAgentName(payload.runtime.kind)
  );
}

// ---------------------------------------------------------------------------
// Payload -> RunSpec
// ---------------------------------------------------------------------------

/**
 * The pinned server image a run needs. Building it once per process is
 * enough: the script is content-addressed, so a second grade of the same
 * workspace re-derives the same digest at full cost. A failure caches
 * too, which is what a suite wants — the next scenario would meet the
 * same engine, and rebuilding to fail again costs minutes per scenario.
 */
const serverImagePin: Effect.Effect<string, HarnessFailure, never> =
  Effect.runSync(
    Effect.cached(
      resolveServerImagePin().pipe(
        Effect.mapError((detail) =>
          failHarness(`The run has no server image: ${detail}.`),
        ),
      ),
    ),
  );

/**
 * The v0 principal speaks once, into one conversation, so a payload that
 * speaks more than once or to more than the target has no run spec. The
 * refusal names the shape instead of running a scenario whose later
 * messages would never be spoken; the shapes return with a principal
 * driver that speaks more than once, not by deleting this check.
 */
function unsupportedShape(payload: HarnessPayload): string | undefined {
  if (payload.conversation.kind !== "direct") {
    return `a "${payload.conversation.kind}" conversation needs participants beyond the target`;
  }
  if (payload.conversation.followUpMessages.length > 0) {
    return `${String(payload.conversation.followUpMessages.length)} follow-up message(s) need more than one principal injection`;
  }
  return undefined;
}

function runtimeAssignment(runtime: HarnessPayload["runtime"]): unknown {
  // Harness runs create fresh conversations with no pre-provisioned
  // NanoClaw registration, so that runtime has to accept them on delivery.
  return runtime.kind === "nanoclaw"
    ? { _tag: "nanoclaw", config: { autoRegisterConversations: true } }
    : { _tag: "openclaw", config: {} };
}

function encodedSpec(input: {
  readonly payload: HarnessPayload;
  readonly imageDigest: string;
  readonly storeRoot: string;
}): unknown {
  const runtime = input.payload.runtime;
  const target = targetAgentName(input.payload);
  return {
    seed: 1,
    agents: [
      {
        name: target,
        runtime: runtimeAssignment(runtime),
        runsIn: "host",
        role: "standard",
      },
    ],
    server: { imageDigest: input.imageDigest },
    episode: {
      task: {
        principal: PRINCIPAL_NAME,
        to: target,
        content: input.payload.conversation.setupMessage,
      },
      termination: {
        inactivityTimeoutMs:
          runtime.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
        onAgentCrash: "halt",
        // One injection and one answer: counting deliveries is safe on a
        // single-injection spec, where nothing later can be pre-empted.
        doneSignal: {
          name: "span-name",
          config: { name: DELIVERED_SPAN, minCount: EXCHANGE_SPAN_COUNT },
        },
      },
    },
    timeouts: {
      readyTimeoutMs: runtime.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    },
    recording: { storeRoot: input.storeRoot },
  };
}

function specFor(input: {
  readonly payload: HarnessPayload;
  readonly imageDigest: string;
  readonly storeRoot: string;
}): Effect.Effect<RunSpec, HarnessFailure, never> {
  return Schema.decodeUnknown(RunSpec)(encodedSpec(input)).pipe(
    Effect.mapError((cause) =>
      failHarness(`The scenario's run spec was rejected: ${cause.message}`),
    ),
  );
}

// ---------------------------------------------------------------------------
// Recording -> bundle
// ---------------------------------------------------------------------------

function readRecordedEvents(
  sealed: SealedAttempt,
): Effect.Effect<ReadonlyArray<SimulatorEvent>, HarnessFailure, never> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.readFileString(join(sealed.recording.path, "events.ndjson")),
    ),
    Effect.mapError((cause) =>
      failHarness(`The sealed recording could not be read: ${String(cause)}`),
    ),
    Effect.flatMap(decodeEventLines),
    Effect.provide(NodeContext.layer),
  );
}

function decodeEventLines(
  text: string,
): Effect.Effect<ReadonlyArray<SimulatorEvent>, HarnessFailure, never> {
  return Effect.forEach(
    text.split("\n").filter((line) => line.trim().length > 0),
    (line) =>
      decodeEventLine(line).pipe(
        Effect.mapError((cause) =>
          failHarness(
            `The recording holds an undecodable event: ${cause.message}`,
          ),
        ),
      ),
    { concurrency: 1 },
  );
}

function projectOrFail(
  events: ReadonlyArray<SimulatorEvent>,
  payload: HarnessPayload,
): Effect.Effect<RecordedConversation, HarnessFailure, never> {
  return projectRecordedConversation({
    events,
    targetSlot: targetAgentName(payload),
    principalName: PRINCIPAL_NAME,
  }).pipe(
    Effect.mapError((cause) => failHarness(unattributableMessage(cause))),
  );
}

function unattributableMessage(cause: RecordingUnattributable): string {
  switch (cause.reason) {
    case "slot-never-ready":
      return `The recording holds no readiness event for "${cause.detail}", so no transcript can be attributed to the target agent.`;
    case "undecodable-agent-id":
      return `The recording carries "${cause.detail}" where the protocol expects an agent id, so its senders cannot be attributed.`;
  }
}

function outcomeFailure(sealed: SealedAttempt): HarnessFailure | undefined {
  const outcome = sealed.outcome;
  switch (outcome._tag) {
    case "episode":
      return outcome.termination === "completed"
        ? undefined
        : failHarness(
            `The run ended "${outcome.termination}" rather than completing; the recording at ${sealed.recording.path} holds what was captured.`,
          );
    case "infrastructure-failure":
      return failHarness(
        `The run failed with ${outcome.errorTag}: ${outcome.errorMessage}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

function recordingRoot(): Effect.Effect<string, HarnessFailure, never> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.makeTempDirectory({ prefix: "moltzap-trace-capture-" }),
    ),
    Effect.mapError((cause) =>
      failHarness(`No recording directory could be created: ${String(cause)}`),
    ),
    Effect.provide(NodeContext.layer),
  );
}

function executeThroughSimulator(input: {
  readonly sourcePath: string;
  readonly payload: HarnessPayload;
  readonly plan: HarnessLoadArgs["plan"];
  readonly runId: string | undefined;
}): Effect.Effect<Readonly<Record<string, unknown>>, HarnessFailure, never> {
  return Effect.gen(function* () {
    const imageDigest = yield* serverImagePin;
    const storeRoot = yield* recordingRoot();
    const spec = yield* specFor({
      payload: input.payload,
      imageDigest,
      storeRoot,
    });
    const runtimeStartedAt = new Date().toISOString();
    const sealed = yield* Effect.scoped(run(spec)).pipe(
      Effect.mapError((cause) =>
        failHarness(`The simulator run failed: ${cause.message}`),
      ),
    );
    const failure = outcomeFailure(sealed);
    if (failure !== undefined) return yield* Effect.fail(failure);
    const conversation = yield* projectOrFail(
      yield* readRecordedEvents(sealed),
      input.payload,
    );
    return buildTraceBundle({
      sourcePath: input.sourcePath,
      payload: input.payload,
      plan: input.plan,
      runId: input.runId ?? sealed.recording.runId,
      targetAgent: {
        agentId: conversation.targetAgentId,
        agentName: targetAgentName(input.payload),
      },
      runtimeStartedAt,
      traceEvents: conversation.traceEvents,
      conversationRun: {
        participants: conversation.participants,
        responses: conversation.responses,
      },
    });
  });
}

function createCoordinator(sourcePath: string, payload: HarnessPayload) {
  return {
    execute(
      plan: HarnessLoadArgs["plan"],
      _harness: unknown,
      opts: { readonly runId?: string } = {},
    ): Effect.Effect<Readonly<Record<string, unknown>>, HarnessFailure, never> {
      return executeThroughSimulator({
        sourcePath,
        payload,
        plan,
        runId: opts.runId,
      });
    },
  };
}

function buildHarnessLoadResult(
  args: HarnessLoadArgs,
  payload: HarnessPayload,
) {
  return {
    plan: buildHarnessPlan(args, payload),
    harness: {
      name: "moltzap-trace-capture",
      run: () =>
        Effect.fail(
          new ExecutionFailed({
            message:
              "MoltZap trace-capture plans require the custom coordinator path",
          }),
        ),
    },
    coordinator: createCoordinator(args.sourcePath, payload),
  };
}

function buildHarnessPlan(args: HarnessLoadArgs, payload: HarnessPayload) {
  return {
    project: args.plan.project,
    scenarioId: args.plan.scenarioId,
    name: args.plan.name,
    description: args.plan.description,
    agents: [targetAgentPlan(payload)],
    requirements: args.plan.requirements,
    metadata: {
      ...args.plan.metadata,
      harness: "moltzap-trace-capture",
      conversationKind: payload.conversation.kind,
      runtimeKind: payload.runtime.kind,
    },
  };
}

function targetAgentPlan(payload: HarnessPayload) {
  return {
    id: PLAN_TARGET_AGENT_ID,
    name: targetAgentName(payload),
    role: "target",
    artifact: {
      _tag: "DockerImageArtifact",
      image: PLACEHOLDER_IMAGE,
      pullPolicy: "never",
    },
    promptInputs: {},
    metadata: {
      runtimeKind: payload.runtime.kind,
    },
  };
}

const traceCaptureHarness = {
  load(args: HarnessLoadArgs) {
    return decodePayload(args.sourcePath, args.payload).pipe(
      // A scenario this fold cannot run must not produce a plan; refusing
      // at load is where cc-judge reports it as a scenario problem rather
      // than as a run that died halfway.
      Effect.flatMap((payload) => runnableShape(payload)),
      Effect.map((payload) => buildHarnessLoadResult(args, payload)),
    );
  },
};

function runnableShape(
  payload: HarnessPayload,
): Effect.Effect<HarnessPayload, HarnessFailure, never> {
  const unsupported = unsupportedShape(payload);
  return unsupported === undefined
    ? Effect.succeed(payload)
    : Effect.fail(
        failHarness(
          `This scenario is not expressible as a simulator run: ${unsupported}. The default out-of-band principal speaks once per run.`,
        ),
      );
}

export default traceCaptureHarness;
