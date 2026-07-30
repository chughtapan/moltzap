import { assert, it } from "@effect/vitest";
import { agentName } from "@moltzap/protocol/identity";
import {
  agentId,
  conversationId,
  messageId,
  taskId,
} from "@moltzap/protocol/testing";
import { ProgramSucceeded, RouterMessageCommitted } from "@moltzap/simulator";
import {
  NanoclawGatewayInput,
  NanoclawGatewayOutput,
  OpenClawGatewayRequest,
  OpenClawGatewaySucceeded,
  OpenClawGatewayTimedOut,
} from "@moltzap/simulator/runtime";
import { routerSequence } from "@moltzap/simulator/network";
import { Effect, Schema, Stream } from "effect";
import {
  CodePeerMessageReceived,
  CodePeerMessageSent,
  EvaluationEvidenceProjectionError,
  EvaluationEvidenceSelected,
  NanoclawPrincipalInputSent,
  NanoclawPrincipalOutputReceived,
  OpenClawPrincipalFinalOutput,
  OpenClawPrincipalInstructionAttempted,
  PeerExchangeNotObserved,
  evaluationEvents,
  projectEvaluationEvidence,
  type EvaluationEvidenceLedgerRecord,
} from "./events.js";
import { decodeEvaluationCaseId, decodeEvaluationEvidenceId } from "./model.js";

const makeAgentName = Schema.decodeSync(agentName);
const decodeOpenClawGatewayResponse = Schema.decodeSync(
  Schema.Union(OpenClawGatewaySucceeded, OpenClawGatewayTimedOut),
);

const CASE_ID = decodeEvaluationCaseId("EVAL-005");
const OTHER_CASE_ID = decodeEvaluationCaseId("EVAL-006");
const ALICE_ID = agentId("00000000-0000-4000-8000-000000000001");
const BOB_ID = agentId("00000000-0000-4000-8000-000000000002");
const TASK_ID = taskId("00000000-0000-4000-8000-000000000003");
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000004");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000005");
const ALICE_NAME = makeAgentName("alice");
const BOB_NAME = makeAgentName("bob");
const IDEMPOTENCY_KEY = "eval-openclaw-instruction";
const PRINCIPAL_INSTRUCTION = "Contact Bob over MoltZap.";
const OPENCLAW_FINAL_TEXT = "I contacted Bob.";
const NANOCLAW_INPUT_TEXT = "Wait for Alice and acknowledge her message.";
const NANOCLAW_OUTPUT_TEXT = "Waiting for Alice.";
const SOCIAL_TEXT = "hello from Alice";

const OPENCLAW_SUBMITTED_ID = decodeEvaluationEvidenceId("eval-run:0");
const OPENCLAW_OUTPUT_ID = decodeEvaluationEvidenceId("eval-run:1");
const NANOCLAW_INPUT_ID = decodeEvaluationEvidenceId("eval-run:2");
const NANOCLAW_OUTPUT_ID = decodeEvaluationEvidenceId("eval-run:3");
const ROUTER_COMMIT_ID = decodeEvaluationEvidenceId("eval-run:4");
const CODE_SENT_ID = decodeEvaluationEvidenceId("eval-run:5");
const CODE_RECEIVED_ID = decodeEvaluationEvidenceId("eval-run:6");
const OPENCLAW_SELECTION_ID = decodeEvaluationEvidenceId("eval-run:7");
const SOCIAL_SELECTION_ID = decodeEvaluationEvidenceId("eval-run:8");

const OPENCLAW_SUBMITTED = OpenClawPrincipalInstructionAttempted.make({
  caseId: CASE_ID,
  agentName: ALICE_NAME,
  agentId: ALICE_ID,
  request: OpenClawGatewayRequest.make({
    message: PRINCIPAL_INSTRUCTION,
    idempotencyKey: IDEMPOTENCY_KEY,
  }),
});

const OPENCLAW_OUTPUT = OpenClawPrincipalFinalOutput.make({
  caseId: CASE_ID,
  agentName: ALICE_NAME,
  agentId: ALICE_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
  output: decodeOpenClawGatewayResponse({
    runId: "openclaw-run",
    status: "ok",
    summary: "completed",
    result: {
      payloads: [{ text: OPENCLAW_FINAL_TEXT }],
    },
  }),
});

const NANOCLAW_INPUT = NanoclawPrincipalInputSent.make({
  caseId: CASE_ID,
  agentName: BOB_NAME,
  agentId: BOB_ID,
  input: NanoclawGatewayInput.make({ text: NANOCLAW_INPUT_TEXT }),
});

const NANOCLAW_OUTPUT = NanoclawPrincipalOutputReceived.make({
  caseId: CASE_ID,
  agentName: BOB_NAME,
  agentId: BOB_ID,
  output: NanoclawGatewayOutput.make({ text: NANOCLAW_OUTPUT_TEXT }),
});

const CODE_SENT = CodePeerMessageSent.make({
  caseId: CASE_ID,
  agentName: ALICE_NAME,
  agentId: ALICE_ID,
  taskId: TASK_ID,
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  parts: [{ type: "text", text: SOCIAL_TEXT }],
});

const CODE_RECEIVED = CodePeerMessageReceived.make({
  caseId: CASE_ID,
  agentName: BOB_NAME,
  agentId: BOB_ID,
  taskId: TASK_ID,
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  senderId: ALICE_ID,
  parts: [{ type: "text", text: SOCIAL_TEXT }],
});

const ROUTER_COMMIT = RouterMessageCommitted.make({
  taskId: TASK_ID,
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  senderId: ALICE_ID,
  routerSequence: routerSequence(0),
});

const OPENCLAW_SELECTION = EvaluationEvidenceSelected.make({
  caseId: CASE_ID,
  selectedEventId: OPENCLAW_OUTPUT_ID,
});

const SOCIAL_SELECTION = EvaluationEvidenceSelected.make({
  caseId: CASE_ID,
  selectedEventId: CODE_RECEIVED_ID,
});
const PEER_TIMEOUT_ID = decodeEvaluationEvidenceId("eval-run:peer-timeout");
const PEER_TIMEOUT = PeerExchangeNotObserved.make({
  caseId: CASE_ID,
  agentName: BOB_NAME,
  agentId: BOB_ID,
  timeoutMillis: 1_000,
});

function record(
  eventId: string,
  logicalSequence: number,
  event: unknown,
): EvaluationEvidenceLedgerRecord {
  return { eventId, logicalSequence, event };
}

function evaluationLedger() {
  return {
    records: Stream.fromIterable([
      record(OPENCLAW_SUBMITTED_ID, 0, OPENCLAW_SUBMITTED),
      record(OPENCLAW_OUTPUT_ID, 1, OPENCLAW_OUTPUT),
      record(NANOCLAW_INPUT_ID, 2, NANOCLAW_INPUT),
      record(NANOCLAW_OUTPUT_ID, 3, NANOCLAW_OUTPUT),
      record(ROUTER_COMMIT_ID, 4, ROUTER_COMMIT),
      record(CODE_SENT_ID, 5, CODE_SENT),
      record(CODE_RECEIVED_ID, 6, CODE_RECEIVED),
      record(OPENCLAW_SELECTION_ID, 7, OPENCLAW_SELECTION),
      record(SOCIAL_SELECTION_ID, 8, SOCIAL_SELECTION),
      record("eval-run:9", 9, ProgramSucceeded.make()),
    ]),
  };
}

// @agent-code-guard/regression-only: exact event catalogs, evidence linkage, and ledger failure cases exercise fixed protocol boundaries
it("declares the complete customer event universe", () => {
  const eventClasses = [
    OpenClawPrincipalInstructionAttempted,
    OpenClawPrincipalFinalOutput,
    NanoclawPrincipalInputSent,
    NanoclawPrincipalOutputReceived,
    CodePeerMessageSent,
    CodePeerMessageReceived,
    PeerExchangeNotObserved,
    EvaluationEvidenceSelected,
  ] as const;

  assert.deepStrictEqual(evaluationEvents.eventClasses, eventClasses);
  assert.deepStrictEqual(
    evaluationEvents.tags,
    eventClasses.map((eventClass) => eventClass._tag),
  );
});

it.effect("projects native gateway evidence in ledger order", () =>
  Effect.gen(function* () {
    const evidence = yield* projectEvaluationEvidence(evaluationLedger());

    assert.deepStrictEqual(
      evidence.gateway.map((entry) => entry.eventId),
      [
        OPENCLAW_SUBMITTED_ID,
        OPENCLAW_OUTPUT_ID,
        NANOCLAW_INPUT_ID,
        NANOCLAW_OUTPUT_ID,
      ],
    );
    const [attempted, output] = evidence.gateway;
    assert.instanceOf(
      attempted?.observation,
      OpenClawPrincipalInstructionAttempted,
    );
    assert.instanceOf(output?.observation, OpenClawPrincipalFinalOutput);
    if (
      attempted?.observation instanceof OpenClawPrincipalInstructionAttempted &&
      output?.observation instanceof OpenClawPrincipalFinalOutput
    ) {
      assert.strictEqual(
        attempted.observation.request.idempotencyKey,
        output.observation.idempotencyKey,
      );
    }
  }),
);

it.effect(
  "pairs endpoint content testimony with content-blind router commits",
  () =>
    Effect.gen(function* () {
      const evidence = yield* projectEvaluationEvidence(evaluationLedger());

      assert.deepStrictEqual(
        evidence.social.map((entry) => entry.eventId),
        [CODE_SENT_ID, CODE_RECEIVED_ID],
      );
      assert.deepStrictEqual(
        evidence.social.map((entry) => entry.routerCommitEventId),
        [ROUTER_COMMIT_ID, ROUTER_COMMIT_ID],
      );
      for (const entry of evidence.social) {
        assert.strictEqual(entry.routerCommit, ROUTER_COMMIT);
        assert.deepStrictEqual(entry.observation.parts, [
          { type: "text", text: SOCIAL_TEXT },
        ]);
        assert.isFalse(Reflect.has(entry.routerCommit, "parts"));
      }
    }),
);

it.effect("returns selected evidence identities in selection order", () =>
  Effect.gen(function* () {
    const evidence = yield* projectEvaluationEvidence(evaluationLedger());

    assert.strictEqual(evidence.caseId, CASE_ID);
    assert.deepStrictEqual(evidence.selectedEventIds, [
      OPENCLAW_OUTPUT_ID,
      CODE_RECEIVED_ID,
    ]);
  }),
);

it.effect("projects selectable bounded peer absence", () =>
  Effect.gen(function* () {
    const selection = EvaluationEvidenceSelected.make({
      caseId: CASE_ID,
      selectedEventId: PEER_TIMEOUT_ID,
    });
    const evidence = yield* projectEvaluationEvidence(
      selectionLedger([
        record(PEER_TIMEOUT_ID, 0, PEER_TIMEOUT),
        record("eval-run:peer-timeout-selection", 1, selection),
      ]),
    );

    assert.lengthOf(evidence.peerTimeouts, 1);
    assert.strictEqual(evidence.peerTimeouts[0]?.observation.agentId, BOB_ID);
    assert.deepStrictEqual(evidence.selectedEventIds, [PEER_TIMEOUT_ID]);
  }),
);

it.effect("requires one case across all customer evidence", () =>
  Effect.gen(function* () {
    const emptyFailure = yield* projectEvaluationEvidence(
      selectionLedger([record("eval-run:0", 0, ProgramSucceeded.make())]),
    ).pipe(Effect.flip);
    assert.include(emptyFailure.detail, "no customer");

    const mixedSelection = EvaluationEvidenceSelected.make({
      caseId: OTHER_CASE_ID,
      selectedEventId: OPENCLAW_OUTPUT_ID,
    });
    const mixedFailure = yield* projectEvaluationEvidence(
      selectionLedger([
        record(OPENCLAW_OUTPUT_ID, 0, OPENCLAW_OUTPUT),
        record("eval-run:1", 1, mixedSelection),
      ]),
    ).pipe(Effect.flip);
    assert.include(mixedFailure.detail, "multiple cases");
  }),
);

function selectionLedger(records: readonly EvaluationEvidenceLedgerRecord[]) {
  return { records: Stream.fromIterable(records) };
}

it.effect("rejects absent, forward, and duplicate evidence selections", () =>
  Effect.gen(function* () {
    const absent = EvaluationEvidenceSelected.make({
      caseId: CASE_ID,
      selectedEventId: decodeEvaluationEvidenceId("eval-run:absent"),
    });
    const absentFailure = yield* projectEvaluationEvidence(
      selectionLedger([record("eval-run:0", 0, absent)]),
    ).pipe(Effect.flip);
    assert.include(absentFailure.detail, "absent");

    const forwardFailure = yield* projectEvaluationEvidence(
      selectionLedger([
        record("eval-run:0", 0, OPENCLAW_SELECTION),
        record(OPENCLAW_OUTPUT_ID, 1, OPENCLAW_OUTPUT),
      ]),
    ).pipe(Effect.flip);
    assert.include(forwardFailure.detail, "before");

    const duplicateFailure = yield* projectEvaluationEvidence(
      selectionLedger([
        record(OPENCLAW_OUTPUT_ID, 0, OPENCLAW_OUTPUT),
        record("eval-run:duplicate-selection-1", 1, OPENCLAW_SELECTION),
        record("eval-run:duplicate-selection-2", 2, OPENCLAW_SELECTION),
      ]),
    ).pipe(Effect.flip);
    assert.include(duplicateFailure.detail, "more than once");
  }),
);

it.effect("rejects social testimony without one matching router commit", () =>
  Effect.gen(function* () {
    const ledger = {
      records: Stream.make(record(CODE_SENT_ID, 0, CODE_SENT)),
    };

    const failure = yield* projectEvaluationEvidence(ledger).pipe(Effect.flip);

    assert.instanceOf(failure, EvaluationEvidenceProjectionError);
    assert.include(failure.detail, CODE_SENT_ID);
  }),
);

it.effect("brands ledger event identities at the projection boundary", () =>
  Effect.gen(function* () {
    const ledger = {
      records: Stream.make(record("", 0, OPENCLAW_SUBMITTED)),
    };

    const failure = yield* projectEvaluationEvidence(ledger).pipe(Effect.flip);

    assert.instanceOf(failure, EvaluationEvidenceProjectionError);
    assert.include(failure.detail, "eventId");
  }),
);
