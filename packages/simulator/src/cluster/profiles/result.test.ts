/** @file The executable's final line round-trips both closed result branches. */

import { assert, effect as test } from "@effect/vitest";
import { Effect, Either, Schema } from "effect";
import type { RunSubmission } from "../submit.js";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
} from "../../ledger/schema.js";
import {
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
} from "../../run/execute.js";
import { encodeProfileRunResult, ProfileRunResult } from "./result.js";

const RUN_ID = "mz-0123456789abcdef0123456789abcdef";
const DIGEST = Schema.decodeSync(ledgerDigest)("a".repeat(64));
const LEDGER = Schema.decodeSync(ledgerRef)("profile-result-test-ledger");
const RECEIPT = CompletedLedgerReceipt.make({
  ledger: LEDGER,
  completion: LedgerCompletion.make({
    ledgerFormatVersion: 1,
    runId: RUN_ID,
    recordCount: 3,
    artifacts: { manifest: DIGEST, records: DIGEST },
  }),
});
const FINISHED: RunSubmission = {
  runId: RUN_ID,
  namespace: RUN_ID,
  result: {
    exitCode: 0,
    summary: { _tag: "ProgramFinished", receipt: RECEIPT },
  },
};
const LOST: RunSubmission = {
  runId: RUN_ID,
  namespace: RUN_ID,
  result: {
    exitCode: 1,
    summary: {
      _tag: "ClusterLost",
      receipt: IncompleteLedgerReceipt.make({ ledger: LEDGER }),
    },
    diagnostic: "controller Job failed",
  },
};

const decodeLine = Schema.decodeUnknownEither(
  Schema.parseJson(ProfileRunResult),
);

test("round-trips a finished run through one JSON line", () =>
  Effect.gen(function* () {
    const line = encodeProfileRunResult(FINISHED);

    assert.notInclude(line, "\n");
    const decoded = yield* Schema.decodeUnknown(
      Schema.parseJson(ProfileRunResult),
    )(line, { onExcessProperty: "error" });
    assert.deepStrictEqual(decoded, FINISHED);
    assert.strictEqual(decoded.result.exitCode, 0);
    if (decoded.result.exitCode === 0) {
      assert.instanceOf(decoded.result.summary.receipt, CompletedLedgerReceipt);
    }
  }));

test("round-trips a lost run, keeping its diagnostic", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(
      Schema.parseJson(ProfileRunResult),
    )(encodeProfileRunResult(LOST), { onExcessProperty: "error" });

    assert.deepStrictEqual(decoded, LOST);
  }));

// The submitter holds the result Temporal handed it, which crossed a JSON
// payload: receipts arrive as plain objects, never as class instances.
// structuredClone drops the prototypes exactly as that payload does.
test("encodes the plain result shape a Temporal payload delivers", () =>
  Effect.sync(() => {
    const plain = structuredClone(FINISHED);

    assert.strictEqual(plain.result.exitCode, 0);
    if (plain.result.exitCode === 0) {
      assert.notInstanceOf(
        plain.result.summary.receipt,
        CompletedLedgerReceipt,
      );
    }
    assert.strictEqual(
      encodeProfileRunResult(plain),
      encodeProfileRunResult(FINISHED),
    );
  }));

test("rejects a line whose result carries an unknown field", () =>
  Effect.sync(() => {
    const widened = JSON.stringify({
      ...FINISHED,
      result: { ...FINISHED.result, stdout: "leaked" },
    });

    assert.isTrue(
      Either.match(decodeLine(widened, { onExcessProperty: "error" }), {
        onLeft: () => true,
        onRight: () => false,
      }),
    );
  }));
