import assert from "node:assert/strict";
import test from "node:test";
import {
  CompletedLedgerReceipt,
  LinkPolicyCleared,
  LinkPolicySet,
  ProgramFailed,
  ProgramInterrupted,
  ProgramSucceeded,
} from "../../packages/simulator/dist/index.js";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
} from "../../packages/simulator/dist/ledger/index.js";
import { Schema } from "effect";
import {
  parseSubmission,
  validateEvidence,
} from "./simulator-local-fault-qualification.mjs";

const DIGEST = "a".repeat(64);
const FROM = "agt_AAAAAAAAAAAAAAAAAAAAAA";
const TO = "agt_AAAAAAAAAAAAAAAAAAAAAg";
const LEDGER_DIGEST = Schema.decodeSync(ledgerDigest)(DIGEST);

function record(logicalSequence, event) {
  return { logicalSequence, event };
}

function completedSubmission() {
  return `${JSON.stringify({
    runId: "mz-1234567812344abc8def1234567890ab",
    namespace: "mz-1234567812344abc8def1234567890ab",
    result: {
      exitCode: 0,
      summary: {
        _tag: "ProgramFinished",
        receipt: CompletedLedgerReceipt.make({
          ledger: Schema.decodeSync(ledgerRef)("qualification-ledger"),
          completion: LedgerCompletion.make({
            ledgerFormatVersion: 1,
            runId: "qualification-run",
            recordCount: 3,
            artifacts: {
              manifest: LEDGER_DIGEST,
              records: LEDGER_DIGEST,
            },
          }),
        }),
      },
    },
  })}\n`;
}

function successfulEvidence() {
  return [
    record(3, LinkPolicySet.make({ from: FROM, to: TO, policy: "hold" })),
    record(7, LinkPolicyCleared.make({ from: FROM, to: TO, policy: "hold" })),
    record(10, ProgramSucceeded.make()),
  ];
}

test("accepts only the closed successful RunSubmission shape", () => {
  const parsed = parseSubmission(completedSubmission());

  assert.equal(parsed.namespace, "mz-1234567812344abc8def1234567890ab");
  assert.equal(parsed.receipt.ledger, "qualification-ledger");
});

test("requires one scoped hold before the single program success", () => {
  assert.deepEqual(validateEvidence(successfulEvidence()), {
    programSucceeded: 1,
    programFailed: 0,
    programInterrupted: 0,
    holdSet: 1,
    holdCleared: 1,
  });

  assert.throws(
    () =>
      validateEvidence([
        record(
          2,
          LinkPolicyCleared.make({ from: FROM, to: TO, policy: "hold" }),
        ),
        successfulEvidence()[0],
        successfulEvidence()[2],
      ]),
    /not scoped before program success/,
  );
});

test("rejects failed, interrupted, duplicate-success, and mismatched-link evidence", () => {
  for (const event of [
    ProgramFailed.make({ cause: "failed" }),
    ProgramInterrupted.make({ cause: "interrupted" }),
    ProgramSucceeded.make(),
  ]) {
    assert.throws(() =>
      validateEvidence([...successfulEvidence(), record(11, event)]),
    );
  }

  const mismatched = successfulEvidence();
  mismatched[1] = record(
    7,
    LinkPolicyCleared.make({ from: TO, to: FROM, policy: "hold" }),
  );
  assert.throws(
    () => validateEvidence(mismatched),
    /did not describe one directed link/,
  );
});
