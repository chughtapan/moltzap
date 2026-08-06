import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  CompletedLedgerReceipt,
  EventCatalog,
  ProgramFailed,
  ProgramSucceeded,
  coreEvents,
} from "@moltzap/simulator";
import {
  LedgerCompletion,
  LedgerManifest,
  ledgerDigest,
  ledgerRef,
  makeLedgerRecordSchema,
  type CompletedLedgerArtifacts,
} from "@moltzap/simulator/ledger";
import { DateTime, Effect, Schema } from "effect";
import { evaluationCases } from "./cases.js";
import { evaluationEvents } from "./events.js";
import {
  EvaluationControllerResultInvalid,
  EvaluationExecutionFailed,
  projectEvaluationControllerResult,
} from "./execution.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- These fixtures pin the controller-to-ledger outcome projection. */

const test = it.effect;
const CATALOG = EventCatalog.merge(coreEvents, evaluationEvents);
const DEFINITION = evaluationCases[0];
const REF = Schema.decodeSync(ledgerRef)(
  "00000000-0000-4000-8000-000000000918",
);
const decodeDigest = Schema.decodeSync(ledgerDigest);

function digest(source: string) {
  return decodeDigest(
    createHash("sha256").update(source, "utf8").digest("hex"),
  );
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("ledger fixture is not JSON encodable");
  }
  return encoded;
}

function completedArtifacts(event: ProgramSucceeded | ProgramFailed): {
  readonly artifacts: CompletedLedgerArtifacts;
  readonly receipt: CompletedLedgerReceipt;
} {
  const manifest = LedgerManifest.make({
    ledgerFormatVersion: 1,
    definitionId: DEFINITION.definitionId,
    runId: "eval-controller-projection-run",
    catalogTags: [...CATALOG.tags].sort((left, right) =>
      left.localeCompare(right),
    ),
    createdAt: DateTime.unsafeMake(0),
    provenance: {},
    metadata: {},
  });
  const manifestText = json(Schema.encodeSync(LedgerManifest)(manifest));
  const record = {
    runId: manifest.runId,
    eventId: "eval-controller-projection:0",
    logicalSequence: 0,
    elapsedNanos: 0n,
    observedAt: 0,
    producer: "eval-controller-projection",
    event,
  };
  const recordsText = `${json(
    Schema.encodeSync(makeLedgerRecordSchema(CATALOG))(record),
  )}\n`;
  const completion = LedgerCompletion.make({
    ledgerFormatVersion: 1,
    runId: manifest.runId,
    recordCount: 1,
    artifacts: {
      manifest: digest(manifestText),
      records: digest(recordsText),
    },
  });
  return {
    artifacts: {
      manifest: manifestText,
      records: recordsText,
      completion: json(Schema.encodeSync(LedgerCompletion)(completion)),
    },
    receipt: CompletedLedgerReceipt.make({ ledger: REF, completion }),
  };
}

test("projects a successful customer program from canonical ledger evidence", () => {
  const fixture = completedArtifacts(ProgramSucceeded.make({}));
  return projectEvaluationControllerResult(
    DEFINITION,
    fixture.receipt,
    fixture.artifacts,
  ).pipe(
    Effect.tap((result) => {
      assert.strictEqual(result._tag, "EvaluationExecutionCompleted");
      assert.strictEqual(result.receipt, fixture.receipt);
    }),
  );
});

test("projects a typed customer failure without trusting controller process state", () => {
  const fixture = completedArtifacts(
    ProgramFailed.make({ cause: "the evaluation program rejected its input" }),
  );
  return projectEvaluationControllerResult(
    DEFINITION,
    fixture.receipt,
    fixture.artifacts,
  ).pipe(
    Effect.tap((result) => {
      assert.instanceOf(result, EvaluationExecutionFailed);
      if (result instanceof EvaluationExecutionFailed) {
        assert.strictEqual(
          result.detail,
          "the evaluation program rejected its input",
        );
      }
    }),
  );
});

test("rejects a controller completion that disagrees with the ledger", () => {
  const fixture = completedArtifacts(ProgramSucceeded.make({}));
  const mismatched = CompletedLedgerReceipt.make({
    ledger: REF,
    completion: LedgerCompletion.make({
      ledgerFormatVersion: fixture.receipt.completion.ledgerFormatVersion,
      runId: fixture.receipt.completion.runId,
      recordCount: fixture.receipt.completion.recordCount,
      artifacts: {
        ...fixture.receipt.completion.artifacts,
        records: decodeDigest("0".repeat(64)),
      },
    }),
  });
  return projectEvaluationControllerResult(
    DEFINITION,
    mismatched,
    fixture.artifacts,
  ).pipe(
    Effect.flip,
    Effect.tap((failure) => {
      assert.instanceOf(failure, EvaluationControllerResultInvalid);
      if (failure instanceof EvaluationControllerResultInvalid) {
        assert.include(failure.detail, "does not match the ledger");
      }
    }),
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Controller projection assertions end here. */
