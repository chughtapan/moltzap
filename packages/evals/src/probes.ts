/** @file Explicit production-network probes for mixed runtime societies. */

import { MessageId, ConversationId } from "@moltzap/protocol/conversation";
import { AgentId } from "@moltzap/protocol/identity";
import { TaskId } from "@moltzap/protocol/task";
import {
  CompletedLedgerReceipt,
  LedgerReceipt,
  Network,
  type NetworkFailure,
  ProgramFinished,
  Simulator,
  effectRuntime,
  nanoclawRuntime,
  openClawRuntime,
  type ConversationSocket,
  type ReceivedMessage,
} from "@moltzap/simulator";
import { Cause, Duration, Effect, Exit, Random, Schema } from "effect";
import {
  readRuntimeTerminationEvidence,
  RuntimeTerminationEvidence,
  RuntimeTerminationEvidenceReadOutcome,
  waitForRuntimeTerminationEvidence,
} from "./events.js";

const PROPOSER_NAME = "nanoclaw-proposer";
const WITNESS_NAME = "effect-witness";
const FINALIZER_NAME = "openclaw-finalizer";
const CONTROLLER_NAME = "probe-controller";
const PROPOSAL_TOKEN = "PROPOSAL:12";
const APPROVAL_PREFIX = "WITNESS:APPROVED:12:";
const FINAL_TOKEN = "FINAL:12";
const APPROVAL_RECEIPT_PREFIX = "RECEIPT:";
const APPROVAL_RECEIPT_MIN = 100_000_000;
const APPROVAL_RECEIPT_MAX = 1_000_000_000;
const MAX_OBSERVED_MESSAGES = 100;
const DEFAULT_PROBE_TIMEOUT = Duration.minutes(10);
const DEFAULT_RUNTIME_STARTUP_TIMEOUT = Duration.minutes(5);

const SharedProbeSociety = Simulator.define("moltzap.shared-runtime-probe/v1");

const SharedProbeRole = Schema.Literal(
  "nanoclaw-proposer",
  "effect-witness",
  "openclaw-finalizer",
);
type SharedProbeRole = typeof SharedProbeRole.Type;

/** One participant message in controller receive order. */
class SharedProbeObservation extends Schema.Class<SharedProbeObservation>(
  "SharedProbeObservation",
)({
  role: SharedProbeRole,
  senderId: AgentId,
  messageId: MessageId,
  text: Schema.String,
}) {}

/** The three-message dependency chain observed in one shared conversation. */
class SharedProbeEvidence extends Schema.Class<SharedProbeEvidence>(
  "SharedProbeEvidence",
)({
  taskId: TaskId,
  conversationId: ConversationId,
  proposal: SharedProbeObservation,
  approval: SharedProbeObservation,
  final: SharedProbeObservation,
}) {}

/** A real NanoClaw → Effect → OpenClaw collaboration completed. */
class SharedProbePassed extends Schema.TaggedClass<SharedProbePassed>()(
  "SharedProbePassed",
  {
    receipt: CompletedLedgerReceipt,
    evidence: SharedProbeEvidence,
  },
) {}

/** The probe retained a ledger but did not complete its dependency chain. */
export class SharedProbeFailed extends Schema.TaggedClass<SharedProbeFailed>()(
  "SharedProbeFailed",
  {
    receipt: LedgerReceipt,
    detail: Schema.NonEmptyString,
    runtimeEvidence: RuntimeTerminationEvidenceReadOutcome,
  },
) {}

const SharedProbeOutcome = Schema.Union(SharedProbePassed, SharedProbeFailed);
type SharedProbeOutcome = typeof SharedProbeOutcome.Type;

/** A bounded probe rejected traffic that never formed the required chain. */
class SharedProbeProtocolFailed extends Schema.TaggedError<SharedProbeProtocolFailed>()(
  "SharedProbeProtocolFailed",
  {
    detail: Schema.NonEmptyString,
  },
) {}

/** Evaluation policy stopped after a roster runtime ceased autonomously. */
export class SharedProbeRuntimeTerminated extends Schema.TaggedError<SharedProbeRuntimeTerminated>()(
  "SharedProbeRuntimeTerminated",
  {
    observation: RuntimeTerminationEvidence,
  },
) {}

export interface SharedConversationProbeOptions {
  readonly openClawModel: string;
  readonly nanoClawModel: string;
  readonly timeout?: Duration.Duration;
  readonly runtimeStartupTimeout?: Duration.Duration;
}

interface ExpectedParticipants {
  readonly proposer: AgentId;
  readonly witness: AgentId;
  readonly finalizer: AgentId;
  readonly approvalReceipt: string;
}

interface ProbeProgress {
  readonly proposal?: SharedProbeObservation;
  readonly approval?: SharedProbeObservation;
  readonly observations: number;
}

interface ApprovedProbeProgress extends ProbeProgress {
  readonly proposal: SharedProbeObservation;
  readonly approval: SharedProbeObservation;
}

function messageText(message: ReceivedMessage): string {
  return message.message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function observation(
  role: SharedProbeRole,
  received: ReceivedMessage,
): SharedProbeObservation {
  return SharedProbeObservation.make({
    role,
    senderId: received.message.senderId,
    messageId: received.message.id,
    text: messageText(received),
  });
}

function isProposal(
  received: ReceivedMessage,
  expected: ExpectedParticipants,
  progress: ProbeProgress,
  text: string,
): boolean {
  return (
    progress.proposal === undefined &&
    received.message.senderId === expected.proposer &&
    text.includes(PROPOSAL_TOKEN)
  );
}

function isApproval(
  received: ReceivedMessage,
  expected: ExpectedParticipants,
  progress: ProbeProgress,
  text: string,
): boolean {
  return (
    progress.proposal !== undefined &&
    progress.approval === undefined &&
    received.message.senderId === expected.witness &&
    text.includes(
      `${APPROVAL_PREFIX}${progress.proposal.messageId}:${APPROVAL_RECEIPT_PREFIX}${expected.approvalReceipt}`,
    )
  );
}

function isFinal(
  received: ReceivedMessage,
  expected: ExpectedParticipants,
  progress: ProbeProgress,
  text: string,
): progress is ApprovedProbeProgress {
  return (
    progress.proposal !== undefined &&
    progress.approval !== undefined &&
    received.message.senderId === expected.finalizer &&
    hasFinalApprovalReceipt(text, expected.approvalReceipt)
  );
}

/** A final response proves it observed the unpredictable witness receipt. */
export function hasFinalApprovalReceipt(
  text: string,
  approvalReceipt: string,
): boolean {
  return text.includes(
    `${FINAL_TOKEN}:${APPROVAL_RECEIPT_PREFIX}${approvalReceipt}`,
  );
}

function nextProgress(
  received: ReceivedMessage,
  expected: ExpectedParticipants,
  progress: ProbeProgress,
): ProbeProgress | SharedProbeEvidence {
  const text = messageText(received);
  const observations = progress.observations + 1;
  if (isProposal(received, expected, progress, text)) {
    return {
      ...progress,
      proposal: observation(PROPOSER_NAME, received),
      observations,
    };
  }
  if (isApproval(received, expected, progress, text)) {
    return {
      ...progress,
      approval: observation(WITNESS_NAME, received),
      observations,
    };
  }
  if (isFinal(received, expected, progress, text)) {
    return SharedProbeEvidence.make({
      taskId: received.taskId,
      conversationId: received.message.conversationId,
      proposal: progress.proposal,
      approval: progress.approval,
      final: observation(FINALIZER_NAME, received),
    });
  }
  return { ...progress, observations };
}

function collectDependencyChain(
  socket: ConversationSocket,
  expected: ExpectedParticipants,
  progress: ProbeProgress,
): Effect.Effect<
  SharedProbeEvidence,
  SharedProbeProtocolFailed | NetworkFailure
> {
  if (progress.observations >= MAX_OBSERVED_MESSAGES) {
    return Effect.fail(
      SharedProbeProtocolFailed.make({
        detail: `the shared conversation produced ${String(MAX_OBSERVED_MESSAGES)} messages without the required dependency chain`,
      }),
    );
  }
  return socket.receive().pipe(
    Effect.flatMap((received) => {
      const next = nextProgress(received, expected, progress);
      return next instanceof SharedProbeEvidence
        ? Effect.succeed(next)
        : Effect.suspend(() => collectDependencyChain(socket, expected, next));
    }),
  );
}

/**
 * Explain the probe protocol without placing its exact expected answers in the
 * controller message.
 */
export function sharedConversationProbePrompt(): string {
  return [
    "Complete this role-specific protocol in this shared conversation.",
    `${PROPOSER_NAME}: calculate 7 + 5 and reply with the prefix PROPOSAL: immediately followed by the decimal result.`,
    `${WITNESS_NAME}: wait for that proposal and validate it.`,
    `${FINALIZER_NAME}: wait for the witness approval, then reply with FINAL:<approved decimal result>:RECEIPT:<the exact receipt from that approval>.`,
    "Do not claim another participant's role and do not skip a dependency.",
  ].join("\n");
}

function failureDetail(cause: Cause.Cause<unknown>): string {
  const detail = Cause.pretty(cause).trim();
  return detail.length > 0 ? detail : "shared conversation probe failed";
}

function probeRoster(
  options: SharedConversationProbeOptions,
  startupTimeout: Duration.Duration,
  approvalReceipt: string,
) {
  const witness = effectRuntime({
    startupTimeout,
    onMessage: ({ message }) => {
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      return text.includes(PROPOSAL_TOKEN)
        ? Effect.succeed(
            `${APPROVAL_PREFIX}${message.id}:${APPROVAL_RECEIPT_PREFIX}${approvalReceipt}`,
          )
        : Effect.succeed(undefined);
    },
  });
  return SharedProbeSociety.agents({
    [PROPOSER_NAME]: nanoclawRuntime({
      installMode: "workspace",
      autoRegisterConversations: true,
      startupTimeout,
      modelId: options.nanoClawModel,
    }),
    [WITNESS_NAME]: witness,
    [FINALIZER_NAME]: openClawRuntime({
      installMode: "workspace",
      startupTimeout,
      modelId: options.openClawModel,
    }),
  });
}

type ProbeRoster = ReturnType<typeof probeRoster>;

function probeProgram(
  roster: ProbeRoster,
  timeout: Duration.Duration,
  approvalReceipt: string,
) {
  return Effect.gen(function* () {
    const agents = yield* roster.Agents;
    const ledger = yield* SharedProbeSociety.Ledger;
    const network = yield* Network;
    const controller = yield* network.endpoint(CONTROLLER_NAME);
    const socket = yield* controller.open(
      agents[PROPOSER_NAME],
      agents[WITNESS_NAME],
      agents[FINALIZER_NAME],
    );
    const protocol = socket.send(sharedConversationProbePrompt()).pipe(
      Effect.zipRight(
        collectDependencyChain(
          socket,
          {
            proposer: agents[PROPOSER_NAME].id,
            witness: agents[WITNESS_NAME].id,
            finalizer: agents[FINALIZER_NAME].id,
            approvalReceipt,
          },
          { observations: 0 },
        ),
      ),
    );
    const runtimeTerminated = waitForRuntimeTerminationEvidence(ledger).pipe(
      Effect.flatMap((observation) =>
        Effect.fail(SharedProbeRuntimeTerminated.make({ observation })),
      ),
    );
    return yield* Effect.raceFirst(protocol, runtimeTerminated);
  }).pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () =>
        SharedProbeProtocolFailed.make({
          detail: "the shared conversation probe timed out",
        }),
    }),
    Effect.withSpan("evals.sharedConversationProbe.program"),
  );
}

function failedProbeOutcome(receipt: LedgerReceipt, detail: string) {
  return readRuntimeTerminationEvidence(
    receipt,
    SharedProbeSociety.openLedger,
  ).pipe(
    Effect.map((runtimeEvidence) =>
      SharedProbeFailed.make({
        receipt,
        detail,
        runtimeEvidence,
      }),
    ),
  );
}

/**
 * Run one real NanoClaw → in-process Effect → real OpenClaw dependency chain
 * over a single production conversation and router.
 */
export const runSharedConversationProbe = Effect.fn(
  "evals.runSharedConversationProbe",
)(function* (options: SharedConversationProbeOptions) {
  const startupTimeout =
    options.runtimeStartupTimeout ?? DEFAULT_RUNTIME_STARTUP_TIMEOUT;
  const approvalReceipt = String(
    yield* Random.nextIntBetween(APPROVAL_RECEIPT_MIN, APPROVAL_RECEIPT_MAX),
  );
  const roster = probeRoster(options, startupTimeout, approvalReceipt);
  const program = probeProgram(
    roster,
    options.timeout ?? DEFAULT_PROBE_TIMEOUT,
    approvalReceipt,
  );
  const outcome = yield* SharedProbeSociety.run(roster, program, {
    provenance: { probe: "shared-runtime-collaboration" },
  });
  if (!(outcome instanceof ProgramFinished)) {
    return yield* failedProbeOutcome(
      outcome.receipt,
      failureDetail(outcome.cause),
    );
  }
  if (Exit.isFailure(outcome.exit)) {
    return yield* failedProbeOutcome(
      outcome.receipt,
      failureDetail(outcome.exit.cause),
    );
  }
  return SharedProbePassed.make({
    receipt: outcome.receipt,
    evidence: outcome.exit.value,
  });
});
