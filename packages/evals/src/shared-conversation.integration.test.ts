/**
 * @file Opt-in shared-conversation measurement across real and code agents.
 *
 * Enable with `MOLTZAP_SHARED_CONVERSATION_ITEST=1`. Optional model overrides
 * are read from `MOLTZAP_OPENCLAW_EVAL_MODEL` and
 * `MOLTZAP_NANOCLAW_EVAL_MODEL`.
 */
import { assert, effect as test, it } from "@effect/vitest";
import {
  type ConversationId,
  conversationId as conversationIdSchema,
  type MessageId,
  messageId as messageIdSchema,
} from "@moltzap/protocol/conversation";
import {
  type AgentId,
  agentId as agentIdSchema,
} from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  AgentRuntimeReady,
  ConversationOpened,
  EndpointMessageReceived,
  EndpointMessageSent,
  EventCatalog,
  Network,
  NetworkFailure,
  ProgramSucceeded,
  RouterMessageCommitted,
  simulator,
  effectRuntime,
  nanoclawRuntime,
  openClawRuntime,
  simulatorLayer,
  type LedgerFailure,
  type ReceivedMessage,
  type SimulatorRunResult,
} from "@moltzap/simulator";
import type { CompletedRunLedger } from "@moltzap/simulator/ledger";
import {
  Cause,
  Chunk,
  Config,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Random,
  Ref,
  Schema,
  Stream,
  TestClock,
  type Brand,
} from "effect";

const INTEGRATION_ENABLED = Effect.runSync(
  Config.string("MOLTZAP_SHARED_CONVERSATION_ITEST").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
);
const OPENCLAW_MODEL = optionalConfig("MOLTZAP_OPENCLAW_EVAL_MODEL");
const NANOCLAW_MODEL = optionalConfig("MOLTZAP_NANOCLAW_EVAL_MODEL");
const RUNTIME_STARTUP_TIMEOUT = Duration.minutes(5);
const ROUTER_STARTUP_TIMEOUT = Duration.minutes(10);
const OBSERVATION_WINDOW = Duration.minutes(5);
const TEST_OBSERVATION_WINDOW = Duration.seconds(1);
const RUN_TIMEOUT = Duration.minutes(40);
const TEST_RUNNER_MARGIN_MS = 5 * 60_000;
const LEDGER_ROOT = "../../eval-results";
const CONTROLLER_NAME = "measurement-controller";
const NANOCLAW_PROPOSAL = "PROPOSED_TOTAL:42";
const EXPECTED_TOTAL = 42;
const EXPECTED_CHECKSUM = 65;
const RECEIPT_RANDOM_BOUND = 0x1000000;
const RECEIPT_HEX_WIDTH = 6;
const WITNESS_APPROVAL_SUFFIX = [
  " Independently calculate checksum=(first item)+(2*second item).",
  " Reply exactly in the requested final-result form.",
].join("");

type ApprovalReceipt = string & Brand.Brand<"ApprovalReceipt">;
const approvalReceipt: Schema.Schema<ApprovalReceipt, string> =
  Schema.String.pipe(
    Schema.pattern(/^EFFECT_RECEIPT_[0-9A-F]{12}$/u),
    Schema.brand("ApprovalReceipt"),
  );
const decodeApprovalReceipt = Schema.decode(approvalReceipt);
const decodeApprovalReceiptOption = Schema.decodeUnknownOption(approvalReceipt);

function receiptFragment(value: number): string {
  return value.toString(16).toUpperCase().padStart(RECEIPT_HEX_WIDTH, "0");
}

const makeApprovalReceipt = Effect.all([
  Random.nextIntBetween(0, RECEIPT_RANDOM_BOUND),
  Random.nextIntBetween(0, RECEIPT_RANDOM_BOUND),
]).pipe(
  Effect.map(
    ([first, second]) =>
      `EFFECT_RECEIPT_${receiptFragment(first)}${receiptFragment(second)}`,
  ),
  Effect.flatMap(decodeApprovalReceipt),
);

function witnessApprovalPrefix(proposalId: MessageId): string {
  return [
    "OpenClaw, the automated witness accepted NanoClaw's proposal.",
    " verified_total=42",
    ` proposal_id=${proposalId}`,
    " receipt=",
  ].join("");
}

function witnessApproval(
  proposalId: MessageId,
  receipt: ApprovalReceipt,
): string {
  return `${witnessApprovalPrefix(proposalId)}${receipt}${WITNESS_APPROVAL_SUFFIX}`;
}

function openClawFinal(
  proposalId: MessageId,
  receipt: ApprovalReceipt,
): string {
  return [
    "OPENCLAW_FINAL",
    `total=${EXPECTED_TOTAL}`,
    `checksum=${EXPECTED_CHECKSUM}`,
    `proposal_id=${proposalId}`,
    `receipt=${receipt}`,
  ].join(" ");
}

function approvalReceiptFrom(
  message: Message,
  proposalId: MessageId,
): Option.Option<ApprovalReceipt> {
  const text = exactText(message);
  const prefix = witnessApprovalPrefix(proposalId);
  if (
    text === undefined ||
    !text.startsWith(prefix) ||
    !text.endsWith(WITNESS_APPROVAL_SUFFIX)
  ) {
    return Option.none();
  }
  return decodeApprovalReceiptOption(
    text.slice(prefix.length, -WITNESS_APPROVAL_SUFFIX.length),
  );
}

const BEGIN = [
  "OpenClaw and NanoClaw, please collaborate on a verified arithmetic task.",
  "NanoClaw: calculate 19 + 23 and propose the total.",
  "Reply exactly in the form PROPOSED_TOTAL:<total>, replacing <total> with",
  "your numeric answer.",
  "The automated participant named witness will validate that proposal and",
  "send OpenClaw an approval receipt that is not present in this request.",
  "OpenClaw: when witness addresses you with the verified total and receipt,",
  "independently check the arithmetic and calculate checksum=(first item)+",
  "(2*second item). Return exactly OPENCLAW_FINAL total=<total>",
  "checksum=<checksum> proposal_id=<proposal_id> receipt=<receipt>, using the",
  "proposal ID and receipt supplied by witness.",
].join(" ");

const OPENCLAW_AGENTS = [
  "# Verified-total participant role",
  "",
  "Wait for the participant named witness to address OpenClaw with a verified",
  "total and an approval receipt. Independently check the arithmetic. If it",
  "is correct, calculate the checksum requested by measurement-controller and",
  "reply in the exact final-result form that measurement-controller requested,",
  "using the",
  "proposal ID and receipt supplied by witness. Include no other text or",
  "attachments.",
  "For every message that is not the witness approval, output exactly NO_REPLY.",
  "Never send progress messages.",
].join("\n");

const NANOCLAW_INSTRUCTIONS = [
  "# Verified-total participant role",
  "",
  `When the exact collaborative request \`${BEGIN}\` arrives from`,
  "measurement-controller, calculate the requested sum and return the proposal in",
  "the requested form with no extra commentary or attachments.",
].join("\n");

/** One response consumed by the customer selection policy. */
class SharedConversationResponse extends Schema.Class<SharedConversationResponse>(
  "SharedConversationResponse",
)({
  messageId: messageIdSchema,
  senderId: agentIdSchema,
}) {}

/** The customer policy selected the expected three-message content sequence. */
class ContentSequenceSelected extends Schema.TaggedClass<ContentSequenceSelected>()(
  "content-sequence-selected",
  {
    openClawMessageId: messageIdSchema,
    witnessMessageId: messageIdSchema,
    nanoClawMessageId: messageIdSchema,
    approvalReceipt: approvalReceipt,
  },
) {}

/** The expected content sequence was not selected during the observation window. */
class ObservationWindowElapsed extends Schema.TaggedClass<ObservationWindowElapsed>()(
  "observation-window-elapsed",
  {
    windowMs: Schema.NonNegativeInt,
  },
) {}

const sharedConversationOutcome = Schema.Union(
  ContentSequenceSelected,
  ObservationWindowElapsed,
);

/** One atomic customer measurement over a shared conversation. */
class SharedConversationMeasured extends Schema.TaggedClass<SharedConversationMeasured>()(
  "moltzap.shared-conversation-measured/v1",
  {
    controllerId: agentIdSchema,
    openClawId: agentIdSchema,
    witnessId: agentIdSchema,
    nanoClawId: agentIdSchema,
    conversationId: conversationIdSchema,
    triggerMessageId: messageIdSchema,
    responses: Schema.Array(SharedConversationResponse),
    outcome: sharedConversationOutcome,
  },
) {}

const sharedConversationEvents = EventCatalog.make(SharedConversationMeasured);
const society = simulator.define(
  "moltzap.shared-conversation-measurement/v1",
  sharedConversationEvents,
);

const TEST_CONTEXT: SharedConversationContext = {
  controllerId: agentId("00000000-0000-4000-8000-000000000001"),
  openClawId: agentId("00000000-0000-4000-8000-000000000002"),
  witnessId: agentId("00000000-0000-4000-8000-000000000003"),
  nanoClawId: agentId("00000000-0000-4000-8000-000000000004"),
  conversationId: conversationId("00000000-0000-4000-8000-000000000006"),
  triggerMessageId: messageId("00000000-0000-4000-8000-000000000007"),
};
const UNEXPECTED_RESPONSE: ReceivedMessage = {
  message: {
    id: messageId("00000000-0000-4000-8000-000000000008"),
    conversationId: TEST_CONTEXT.conversationId,
    senderId: TEST_CONTEXT.nanoClawId,
    parts: [{ type: "text", text: "WORKING" }],
    createdAt: "2026-07-29T00:00:00.000Z",
  },
};

const agents = society.agents({
  openclaw: openClawRuntime({
    installMode: "workspace",
    startupTimeout: RUNTIME_STARTUP_TIMEOUT,
    workspaceFiles: [{ relativePath: "AGENTS.md", content: OPENCLAW_AGENTS }],
    ...(OPENCLAW_MODEL === undefined ? {} : { modelId: OPENCLAW_MODEL }),
  }),
  nanoclaw: nanoclawRuntime({
    installMode: "workspace",
    autoRegisterConversations: true,
    startupTimeout: RUNTIME_STARTUP_TIMEOUT,
    workspaceFiles: [
      {
        relativePath: "verified-total/instructions.md",
        content: NANOCLAW_INSTRUCTIONS,
      },
    ],
    ...(NANOCLAW_MODEL === undefined ? {} : { modelId: NANOCLAW_MODEL }),
  }),
  witness: effectRuntime({
    onMessage: ({ message }) =>
      exactText(message) === NANOCLAW_PROPOSAL
        ? makeApprovalReceipt.pipe(
            Effect.map((receipt) => witnessApproval(message.id, receipt)),
          )
        : Effect.succeed(undefined),
  }),
});

function optionalConfig(name: string): string | undefined {
  const value = Effect.runSync(
    Config.string(name).pipe(Config.withDefault("")),
  ).trim();
  return value.length === 0 ? undefined : value;
}

function exactText(message: Message): string | undefined {
  return exactPartsText(message.parts);
}

function exactPartsText(parts: Message["parts"]): string | undefined {
  if (parts.length !== 1) {
    return undefined;
  }
  const [part] = parts;
  return part.type === "text" ? part.text.trim() : undefined;
}

interface SharedConversationContext {
  readonly controllerId: AgentId;
  readonly openClawId: AgentId;
  readonly witnessId: AgentId;
  readonly nanoClawId: AgentId;
  readonly conversationId: ConversationId;
  readonly triggerMessageId: MessageId;
}

type ReceiveResponse = () => Effect.Effect<ReceivedMessage, NetworkFailure>;

function receiveWhere(
  receive: ReceiveResponse,
  predicate: (received: ReceivedMessage) => boolean,
): Effect.Effect<ReceivedMessage, NetworkFailure> {
  return receiveSome(receive, (received) =>
    predicate(received) ? Option.some(received) : Option.none(),
  );
}

function receiveSome<A>(
  receive: ReceiveResponse,
  select: (received: ReceivedMessage) => Option.Option<A>,
): Effect.Effect<A, NetworkFailure> {
  return receive().pipe(
    Effect.flatMap((received) =>
      Option.match(select(received), {
        onNone: () => Effect.suspend(() => receiveSome(receive, select)),
        onSome: Effect.succeed,
      }),
    ),
  );
}

function receiveContentSequence(
  receive: ReceiveResponse,
  context: SharedConversationContext,
) {
  return Effect.gen(function* () {
    const nanoClaw = yield* receiveWhere(
      receive,
      ({ message }) =>
        message.senderId === context.nanoClawId &&
        exactText(message) === NANOCLAW_PROPOSAL,
    );
    const witnessSelection = yield* receiveSome(receive, (received) =>
      received.message.senderId === context.witnessId
        ? approvalReceiptFrom(received.message, nanoClaw.message.id).pipe(
            Option.map((approvalReceipt) => ({ received, approvalReceipt })),
          )
        : Option.none(),
    );
    const { approvalReceipt, received: witness } = witnessSelection;
    const openClaw = yield* receiveWhere(
      receive,
      ({ message }) =>
        message.senderId === context.openClawId &&
        exactText(message) ===
          openClawFinal(nanoClaw.message.id, approvalReceipt),
    );
    return { openClaw, witness, nanoClaw, approvalReceipt };
  });
}

function responseObservation(
  received: ReceivedMessage,
): SharedConversationResponse {
  return SharedConversationResponse.make({
    messageId: received.message.id,
    senderId: received.message.senderId,
  });
}

function appendResponse(
  responses: Ref.Ref<readonly SharedConversationResponse[]>,
  received: ReceivedMessage,
) {
  return Ref.update(responses, (current) => [
    ...current,
    responseObservation(received),
  ]).pipe(Effect.as(received));
}

function observeResponse(
  responses: Ref.Ref<readonly SharedConversationResponse[]>,
  receive: ReceiveResponse,
) {
  return Effect.uninterruptibleMask((restore) =>
    restore(receive()).pipe(
      Effect.flatMap((received) => appendResponse(responses, received)),
    ),
  );
}

const measureContentSequence = Effect.fn(
  "evals.measureSharedConversationContentSequence",
)(function* (
  receive: ReceiveResponse,
  context: SharedConversationContext,
  observationWindow: Duration.Duration,
) {
  const responses = yield* Ref.make<readonly SharedConversationResponse[]>([]);
  const observedReceive = () => observeResponse(responses, receive);
  const transcript = yield* receiveContentSequence(
    observedReceive,
    context,
  ).pipe(Effect.timeoutOption(observationWindow));
  const observed = yield* Ref.get(responses);
  return {
    responses: observed,
    outcome: Option.match(transcript, {
      onNone: () =>
        ObservationWindowElapsed.make({
          windowMs: Duration.toMillis(observationWindow),
        }),
      onSome: (content) =>
        ContentSequenceSelected.make({
          openClawMessageId: content.openClaw.message.id,
          witnessMessageId: content.witness.message.id,
          nanoClawMessageId: content.nanoClaw.message.id,
          approvalReceipt: content.approvalReceipt,
        }),
    }),
  } as const;
});

const recordMeasurement = Effect.fn("evals.recordSharedConversation")(
  function* (
    context: SharedConversationContext,
    measurement: {
      readonly responses: readonly SharedConversationResponse[];
      readonly outcome: ContentSequenceSelected | ObservationWindowElapsed;
    },
  ) {
    const events = yield* society.events;
    yield* events.emit(
      SharedConversationMeasured.make({
        ...context,
        responses: measurement.responses,
        outcome: measurement.outcome,
      }),
      {
        causationId:
          measurement.outcome._tag === "content-sequence-selected"
            ? measurement.outcome.openClawMessageId
            : context.triggerMessageId,
        correlationId: context.triggerMessageId,
      },
    );
  },
);

function sharedConversationProgram() {
  return Effect.gen(function* () {
    const started = yield* agents.startedAgents;
    const network = yield* Network;
    const controller = yield* network.endpoint(CONTROLLER_NAME);
    const conversation = yield* controller.open(
      started.openclaw,
      started.nanoclaw,
      started.witness,
    );
    const trigger = yield* conversation.send(BEGIN);
    const context = {
      controllerId: controller.participant.id,
      openClawId: started.openclaw.id,
      witnessId: started.witness.id,
      nanoClawId: started.nanoclaw.id,
      conversationId: conversation.address.conversationId,
      triggerMessageId: trigger.id,
    };
    const measurement = yield* measureContentSequence(
      () => conversation.receive(),
      context,
      OBSERVATION_WINDOW,
    );
    yield* recordMeasurement(context, measurement);
    return undefined;
  });
}

function collectEvidence(ledger: CompletedRunLedger<typeof society.catalog>) {
  return Effect.all({
    ready: Stream.runCollect(ledger.events(AgentRuntimeReady)),
    conversations: Stream.runCollect(ledger.events(ConversationOpened)),
    sent: Stream.runCollect(ledger.events(EndpointMessageSent)),
    received: Stream.runCollect(ledger.events(EndpointMessageReceived)),
    measured: Stream.runCollect(ledger.events(SharedConversationMeasured)),
    succeeded: Stream.runCollect(ledger.events(ProgramSucceeded)),
    router: Stream.runCollect(ledger.events(RouterMessageCommitted)),
    processExited: Stream.runCollect(ledger.events(AgentProcessExited)),
    processSignaled: Stream.runCollect(ledger.events(AgentProcessSignaled)),
    runtimeCompleted: Stream.runCollect(ledger.events(AgentRuntimeCompleted)),
    runtimeFailed: Stream.runCollect(ledger.events(AgentRuntimeFailed)),
  });
}

type SharedConversationEvidence = Effect.Effect.Success<
  ReturnType<typeof collectEvidence>
>;

interface ExpectedRecordedMessage {
  readonly messageId: MessageId;
  readonly senderId: AgentId;
  readonly text: string;
}

interface EndpointConversationEvent {
  readonly endpointId: AgentId;
  readonly conversationId: ConversationId;
}

function belongsToConversation(
  event: EndpointConversationEvent,
  context: SharedConversationContext,
): boolean {
  return (
    event.endpointId === context.controllerId &&
    event.conversationId === context.conversationId
  );
}

function receivedById(
  received: readonly EndpointMessageReceived[],
  expected: ExpectedRecordedMessage,
): EndpointMessageReceived {
  const match = received.find(
    (event) =>
      event.messageId === expected.messageId &&
      event.senderId === expected.senderId,
  );
  assert.isDefined(match);
  assert.strictEqual(exactPartsText(match.parts), expected.text);
  return match;
}

function assertReadyAgents(
  ready: readonly AgentRuntimeReady[],
  context: SharedConversationContext,
): void {
  assert.deepStrictEqual(
    ready
      .map((event) => ({
        name: String(event.agentName),
        id: event.agentId,
        runtime: event.runtime,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    [
      { name: "nanoclaw", id: context.nanoClawId, runtime: "nanoclaw" },
      { name: "openclaw", id: context.openClawId, runtime: "openclaw" },
      { name: "witness", id: context.witnessId, runtime: "effect" },
    ],
  );
}

function assertConversation(
  conversations: readonly ConversationOpened[],
  context: SharedConversationContext,
): void {
  assert.deepStrictEqual(
    conversations.map((opened) => ({
      conversationId: opened.conversationId,
      openedBy: opened.openedBy,
      participants: [...opened.participants].sort((left, right) =>
        left.localeCompare(right),
      ),
    })),
    [
      {
        conversationId: context.conversationId,
        openedBy: context.controllerId,
        participants: [
          context.controllerId,
          context.nanoClawId,
          context.openClawId,
          context.witnessId,
        ].sort((left, right) => left.localeCompare(right)),
      },
    ],
  );
}

function assertTrigger(
  sent: readonly EndpointMessageSent[],
  context: SharedConversationContext,
): void {
  assert.deepStrictEqual(
    sent.map((event) => ({
      endpointId: event.endpointId,
      conversationId: event.conversationId,
      messageId: event.messageId,
      text: exactPartsText(event.parts),
    })),
    [
      {
        endpointId: context.controllerId,
        conversationId: context.conversationId,
        messageId: context.triggerMessageId,
        text: BEGIN,
      },
    ],
  );
}

function assertMeasuredResponses(
  measured: readonly SharedConversationResponse[],
  received: readonly EndpointMessageReceived[],
  committed: readonly RouterMessageCommitted[],
  context: SharedConversationContext,
): void {
  for (const response of measured) {
    assert.lengthOf(
      received.filter(
        (event) =>
          belongsToConversation(event, context) &&
          event.messageId === response.messageId &&
          event.senderId === response.senderId,
      ),
      1,
    );
    assert.lengthOf(
      committed.filter(
        (event) =>
          event.conversationId === context.conversationId &&
          event.messageId === response.messageId &&
          event.senderId === response.senderId,
      ),
      1,
    );
  }
  assert.lengthOf(
    committed.filter(
      (event) =>
        event.conversationId === context.conversationId &&
        event.messageId === context.triggerMessageId &&
        event.senderId === context.controllerId,
    ),
    1,
  );
}

function assertRouterContentSequence(
  committed: readonly RouterMessageCommitted[],
  context: SharedConversationContext,
  selected: ContentSequenceSelected,
): void {
  const selectedIds = new Set([
    context.triggerMessageId,
    selected.openClawMessageId,
    selected.witnessMessageId,
    selected.nanoClawMessageId,
  ]);
  const sequence = committed
    .filter(
      (event) =>
        event.conversationId === context.conversationId &&
        selectedIds.has(event.messageId),
    )
    .sort((left, right) => left.routerSequence - right.routerSequence);
  assert.deepStrictEqual(
    sequence.map((event) => [event.messageId, event.senderId]),
    [
      [context.triggerMessageId, context.controllerId],
      [selected.nanoClawMessageId, context.nanoClawId],
      [selected.witnessMessageId, context.witnessId],
      [selected.openClawMessageId, context.openClawId],
    ],
  );
}

function assertRecordedContentSequence(
  received: readonly EndpointMessageReceived[],
  context: SharedConversationContext,
  selected: ContentSequenceSelected,
): void {
  const selectedIds = new Set([
    selected.openClawMessageId,
    selected.witnessMessageId,
    selected.nanoClawMessageId,
  ]);
  const sequence = received.filter(
    (event) =>
      belongsToConversation(event, context) && selectedIds.has(event.messageId),
  );
  receivedById(sequence, {
    messageId: selected.nanoClawMessageId,
    senderId: context.nanoClawId,
    text: NANOCLAW_PROPOSAL,
  });
  receivedById(sequence, {
    messageId: selected.witnessMessageId,
    senderId: context.witnessId,
    text: witnessApproval(selected.nanoClawMessageId, selected.approvalReceipt),
  });
  receivedById(sequence, {
    messageId: selected.openClawMessageId,
    senderId: context.openClawId,
    text: openClawFinal(selected.nanoClawMessageId, selected.approvalReceipt),
  });
  assert.deepStrictEqual(
    sequence.map((event) => event.messageId),
    [
      selected.nanoClawMessageId,
      selected.witnessMessageId,
      selected.openClawMessageId,
    ],
  );
}

/**
 * The recorded responses hold exactly one entry for this message and sender.
 * @param responses Value supplied to the operation.
 * @param messageId Value supplied to the operation.
 * @param senderId Value supplied to the operation.
 */
function assertRecordedExactlyOnce(
  responses: readonly SharedConversationResponse[],
  messageId: MessageId,
  senderId: AgentId,
): void {
  const matching = responses.filter(
    (response) =>
      response.messageId === messageId && response.senderId === senderId,
  );
  assert.lengthOf(matching, 1);
}

function assertHealthyCompletion(evidence: SharedConversationEvidence): void {
  assert.strictEqual(Chunk.size(evidence.succeeded), 1);
  const terminalFailures = [
    ...Chunk.toReadonlyArray(evidence.processExited),
    ...Chunk.toReadonlyArray(evidence.processSignaled),
    ...Chunk.toReadonlyArray(evidence.runtimeCompleted),
    ...Chunk.toReadonlyArray(evidence.runtimeFailed),
  ];
  assert.lengthOf(terminalFailures, 0);
}

function assertMeasurementEnvelope(
  evidence: SharedConversationEvidence,
  measurement: SharedConversationMeasured,
): void {
  assertReadyAgents(Chunk.toReadonlyArray(evidence.ready), measurement);
  assertConversation(
    Chunk.toReadonlyArray(evidence.conversations),
    measurement,
  );
  assertTrigger(Chunk.toReadonlyArray(evidence.sent), measurement);
  assertHealthyCompletion(evidence);
  assertMeasuredResponses(
    measurement.responses,
    Chunk.toReadonlyArray(evidence.received),
    Chunk.toReadonlyArray(evidence.router),
    measurement,
  );
}

function assertEvidence(evidence: SharedConversationEvidence) {
  const measurements = Chunk.toReadonlyArray(evidence.measured);
  assert.lengthOf(measurements, 1);
  const [measurement] = measurements;
  assert.isDefined(measurement);
  assertMeasurementEnvelope(evidence, measurement);

  if (measurement.outcome._tag === "observation-window-elapsed") {
    return {
      outcome: "observation-window-elapsed" as const,
      context: measurement,
      responses: measurement.responses,
      observationWindowMs: measurement.outcome.windowMs,
    };
  }

  const selected = measurement.outcome;
  assertRecordedContentSequence(
    Chunk.toReadonlyArray(evidence.received),
    measurement,
    selected,
  );
  assertRouterContentSequence(
    Chunk.toReadonlyArray(evidence.router),
    measurement,
    selected,
  );
  assertRecordedExactlyOnce(
    measurement.responses,
    selected.witnessMessageId,
    measurement.witnessId,
  );
  assertRecordedExactlyOnce(
    measurement.responses,
    selected.openClawMessageId,
    measurement.openClawId,
  );
  return {
    outcome: "content-sequence-selected" as const,
    context: measurement,
    responses: measurement.responses,
    selection: selected,
  };
}

type SharedConversationRun = SimulatorRunResult<
  undefined,
  NetworkFailure | LedgerFailure
>;
type ValidatedEvidence = ReturnType<typeof assertEvidence>;

function measurementResult(
  run: SharedConversationRun,
  evidence: ValidatedEvidence,
) {
  const context = evidence.context;
  const common = {
    type: "moltzap.shared-conversation-result/v1",
    definitionId: society.id,
    ledgerRef: run.ledger,
    runId: run.completion.runId,
    completion: Object.freeze({
      ledgerFormatVersion: run.completion.ledgerFormatVersion,
      recordCount: run.completion.recordCount,
      artifacts: Object.freeze({ ...run.completion.artifacts }),
    }),
    conversationId: context.conversationId,
    controllerId: context.controllerId,
    openClawId: context.openClawId,
    witnessId: context.witnessId,
    nanoClawId: context.nanoClawId,
    triggerMessageId: context.triggerMessageId,
    responses: evidence.responses,
  } as const;
  return evidence.outcome === "content-sequence-selected"
    ? Object.freeze({
        ...common,
        outcome: evidence.outcome,
        contentSequence: Object.freeze({
          nanoClawMessageId: evidence.selection.nanoClawMessageId,
          witnessMessageId: evidence.selection.witnessMessageId,
          openClawMessageId: evidence.selection.openClawMessageId,
          approvalReceipt: evidence.selection.approvalReceipt,
        }),
      })
    : Object.freeze({
        ...common,
        outcome: evidence.outcome,
        observationWindowMs: evidence.observationWindowMs,
      });
}

const sharedConversationMeasurement = Effect.fn(
  "evals.measureSharedConversation",
)(function* () {
  const run = yield* society.run(agents, sharedConversationProgram(), {
    provenance: {
      evaluation: "shared-conversation-content-sequence",
      condition: "production-openclaw-effect-nanoclaw",
    },
  });
  if (Exit.isFailure(run.exit)) {
    return yield* Effect.failCause(run.exit.cause);
  }

  const ledger = yield* society.openLedger(run.ledger);
  const evidence = assertEvidence(yield* collectEvidence(ledger));
  yield* Effect.logInfo(
    `MOLTZAP_SHARED_CONVERSATION_RESULT ${JSON.stringify(measurementResult(run, evidence))}`,
  );
});

const platformLayer = simulatorLayer({
  ledgerDirectory: LEDGER_ROOT,
  router: { startupTimeout: ROUTER_STARTUP_TIMEOUT },
});

test("records a missed content sequence as elapsed result data", () => {
  let receiveCount = 0;
  const receive: ReceiveResponse = () =>
    Effect.suspend(() => {
      const current = receiveCount;
      receiveCount += 1;
      return current === 0 ? Effect.succeed(UNEXPECTED_RESPONSE) : Effect.never;
    });

  return Effect.gen(function* () {
    const fiber = yield* measureContentSequence(
      receive,
      TEST_CONTEXT,
      TEST_OBSERVATION_WINDOW,
    ).pipe(Effect.fork);
    yield* Effect.yieldNow();
    yield* TestClock.adjust(TEST_OBSERVATION_WINDOW);
    const measurement = yield* Fiber.join(fiber);

    if (measurement.outcome._tag !== "observation-window-elapsed") {
      return assert.fail("expected observation window to elapse");
    }
    assert.strictEqual(
      measurement.outcome.windowMs,
      Duration.toMillis(TEST_OBSERVATION_WINDOW),
    );
    assert.lengthOf(measurement.responses, 1);
    const [response] = measurement.responses;
    assert.isDefined(response);
    assert.strictEqual(response.messageId, UNEXPECTED_RESPONSE.message.id);
    assert.strictEqual(response.senderId, TEST_CONTEXT.nanoClawId);
  });
});

test("preserves a receive failure instead of recording elapsed behavior", () => {
  const failure = NetworkFailure.make({
    operation: "receive",
    detail: "connection closed",
  });
  return Effect.gen(function* () {
    const exit = yield* measureContentSequence(
      () => Effect.fail(failure),
      TEST_CONTEXT,
      TEST_OBSERVATION_WINDOW,
    ).pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const observed = Cause.failureOption(exit.cause);
      assert.isTrue(Option.isSome(observed));
      if (Option.isSome(observed)) {
        assert.instanceOf(observed.value, NetworkFailure);
        assert.strictEqual(observed.value.operation, failure.operation);
        assert.strictEqual(observed.value.detail, failure.detail);
      }
    }
  });
});

it.scopedLive.skipIf(!INTEGRATION_ENABLED)(
  "measures NanoClaw, Effect, and OpenClaw in one conversation",
  () =>
    sharedConversationMeasurement().pipe(
      Effect.provide(platformLayer),
      Effect.timeout(RUN_TIMEOUT),
    ),
  Duration.toMillis(RUN_TIMEOUT) + TEST_RUNNER_MARGIN_MS,
);
