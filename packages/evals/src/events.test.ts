import { assert, it } from "@effect/vitest";
import {
  agentId,
  conversationId,
  messageId,
  taskId,
} from "@moltzap/protocol/testing";
import { AgentName } from "@moltzap/protocol/identity";
import {
  AgentProcessExited,
  AgentRuntimeCompleted,
  AgentRuntimeStartFailed,
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
  ProgramSucceeded,
} from "@moltzap/simulator";
import {
  LedgerCompletion,
  LedgerDigest,
  LedgerRef,
} from "@moltzap/simulator/ledger";
import { Effect, Schema, Stream } from "effect";
import { EvaluationCaseId } from "./cases.js";
import type { EpisodeResponse } from "./episodes.js";
import {
  EvaluationResponseSelected,
  RuntimeTerminationEvidenceIncompleteLedger,
  RuntimeTerminationEvidenceRead,
  RuntimeTerminationEvidenceReadFailed,
  readRuntimeTerminationEvidence,
  runtimeTerminationEvidenceFromLedger,
  selectEvaluationResponse,
  waitForRuntimeTerminationEvidence,
} from "./events.js";

const CASE_ID = Schema.decodeSync(EvaluationCaseId)("EVAL-005");
const ENDPOINT_ID = agentId("00000000-0000-4000-8000-000000000001");
const TARGET_ID = agentId("00000000-0000-4000-8000-000000000002");
const TASK_ID = taskId("00000000-0000-4000-8000-000000000003");
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000004");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000005");
const PROMPT_MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000007");
const RUNTIME_AGENT_ID = agentId("00000000-0000-4000-8000-000000000006");
const RUNTIME_AGENT_NAME = Schema.decodeSync(AgentName)("runtime-agent");
const LEDGER_REF = Schema.decodeSync(LedgerRef)("runtime-evidence-ledger");
const MANIFEST_DIGEST = Schema.decodeSync(LedgerDigest)("a".repeat(64));
const RECORDS_DIGEST = Schema.decodeSync(LedgerDigest)("b".repeat(64));

function completedReceipt(): CompletedLedgerReceipt {
  return CompletedLedgerReceipt.make({
    ledger: LEDGER_REF,
    completion: LedgerCompletion.make({
      ledgerFormatVersion: 1,
      runId: "runtime-evidence-run",
      recordCount: 3,
      artifacts: {
        manifest: MANIFEST_DIGEST,
        records: RECORDS_DIGEST,
      },
    }),
  });
}

const START_FAILED = AgentRuntimeStartFailed.make({
  agentName: RUNTIME_AGENT_NAME,
  runtime: "nanoclaw",
  cause: "startup failed",
});
const COMPLETED = AgentRuntimeCompleted.make({
  agentName: RUNTIME_AGENT_NAME,
  agentId: RUNTIME_AGENT_ID,
  runtime: "effect",
});
const EXITED = AgentProcessExited.make({
  agentName: RUNTIME_AGENT_NAME,
  agentId: RUNTIME_AGENT_ID,
  runtime: "openclaw",
  code: 1,
});

function runtimeLedger() {
  return {
    records: Stream.fromIterable([
      { event: ProgramSucceeded.make() },
      { event: START_FAILED },
      { event: COMPLETED },
      { event: EXITED },
    ]),
  };
}

function response(): EpisodeResponse {
  return {
    endpointName: "eval-sender",
    endpointId: ENDPOINT_ID,
    targetName: "evaluation-target",
    targetId: TARGET_ID,
    promptMessageId: PROMPT_MESSAGE_ID,
    received: {
      taskId: TASK_ID,
      message: {
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        senderId: TARGET_ID,
        replyToId: PROMPT_MESSAGE_ID,
        parts: [{ type: "text", text: "response" }],
        createdAt: "2026-07-29T00:00:00.000Z",
      },
    },
  };
}

// @agent-code-guard/regression-only: selected evidence must bind the full canonical conversation address
it("retains the selected response conversation identity", () => {
  const selected = selectEvaluationResponse(CASE_ID, response());

  assert.instanceOf(selected, EvaluationResponseSelected);
  assert.strictEqual(
    selected._tag,
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- persisted event versions are exact compatibility contracts.
    "moltzap.evaluation-response-selected/v4",
  );
  assert.strictEqual(selected.taskId, TASK_ID);
  assert.strictEqual(selected.conversationId, CONVERSATION_ID);
  assert.strictEqual(selected.promptMessageId, PROMPT_MESSAGE_ID);
  assert.strictEqual(selected.messageId, MESSAGE_ID);
});

it.effect("projects runtime evidence in ledger order", () =>
  Effect.gen(function* () {
    const observations = yield* runtimeTerminationEvidenceFromLedger(
      runtimeLedger(),
    );

    assert.deepStrictEqual(observations, [START_FAILED, COMPLETED, EXITED]);
  }),
);

it.effect("waits for the first runtime observation", () =>
  Effect.gen(function* () {
    const observation = yield* waitForRuntimeTerminationEvidence(
      runtimeLedger(),
    );

    assert.instanceOf(observation, AgentRuntimeStartFailed);
    assert.deepStrictEqual(observation, START_FAILED);
  }),
);

it.effect("distinguishes read, unreadable, and incomplete evidence", () =>
  Effect.gen(function* () {
    const read = yield* readRuntimeTerminationEvidence(completedReceipt(), () =>
      Effect.succeed(runtimeLedger()),
    );
    assert.instanceOf(read, RuntimeTerminationEvidenceRead);
    if (read instanceof RuntimeTerminationEvidenceRead) {
      assert.deepStrictEqual(read.observations, [
        START_FAILED,
        COMPLETED,
        EXITED,
      ]);
    }

    const unreadable = yield* readRuntimeTerminationEvidence(
      completedReceipt(),
      () => Effect.fail("ledger validation failed"),
    );
    assert.instanceOf(unreadable, RuntimeTerminationEvidenceReadFailed);
    if (unreadable instanceof RuntimeTerminationEvidenceReadFailed) {
      assert.include(unreadable.detail, "ledger validation failed");
    }

    const incomplete = yield* readRuntimeTerminationEvidence(
      IncompleteLedgerReceipt.make({ ledger: LEDGER_REF }),
      () => Effect.dieMessage("an incomplete receipt must not be opened"),
    );
    assert.instanceOf(incomplete, RuntimeTerminationEvidenceIncompleteLedger);
  }),
);
