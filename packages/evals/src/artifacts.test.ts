import { NodeContext } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ledgerRef } from "@moltzap/simulator/ledger";
import { Effect, Schema } from "effect";
import {
  EvaluationArtifactReadFailed,
  readEvaluationLedgerArtifactsWith,
  type EvaluationArtifactOperations,
} from "./artifacts.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- These tests pin the external artifact identities and immutable file set. */

const test = it.effect;
const REF = Schema.decodeSync(ledgerRef)(
  "00000000-0000-4000-8000-000000000917",
);
const ARTIFACTS = {
  manifest: "manifest contents",
  records: "record contents",
  completion: "completion contents",
} as const;

function content(identity: string): string {
  if (identity.endsWith("/manifest.json")) {
    return ARTIFACTS.manifest;
  }
  if (identity.endsWith("/records.ndjson")) {
    return ARTIFACTS.records;
  }
  if (identity.endsWith("/completion.json")) {
    return ARTIFACTS.completion;
  }
  throw new Error(`unexpected artifact identity ${identity}`);
}

function operations(
  fileIdentities: string[],
  objectIdentities: string[],
): EvaluationArtifactOperations {
  return Object.freeze({
    readFile: (identity: string) =>
      Effect.sync(() => {
        fileIdentities.push(identity);
        return content(identity);
      }),
    readObject: (identity: string) =>
      Effect.sync(() => {
        objectIdentities.push(identity);
        return content(identity);
      }),
  });
}

test("reads the exact local namespace ledger artifact set", () => {
  const files: string[] = [];
  const objects: string[] = [];
  return readEvaluationLedgerArtifactsWith(
    {
      profile: "local",
      namespace: "mz-run-917",
      ref: REF,
      localArtifacts: "/var/lib/moltzap/artifacts",
    },
    operations(files, objects),
  ).pipe(
    Effect.tap((artifacts) => {
      assert.deepStrictEqual(artifacts, ARTIFACTS);
      assert.deepStrictEqual(objects, []);
      assert.deepStrictEqual(
        [...files].sort((left, right) => left.localeCompare(right)),
        [
          `/var/lib/moltzap/artifacts/mz-run-917/ledger/${REF}/completion.json`,
          `/var/lib/moltzap/artifacts/mz-run-917/ledger/${REF}/manifest.json`,
          `/var/lib/moltzap/artifacts/mz-run-917/ledger/${REF}/records.ndjson`,
        ],
      );
    }),
    Effect.provide(NodeContext.layer),
  );
});

test("reads the exact GCS namespace ledger artifact set", () => {
  const files: string[] = [];
  const objects: string[] = [];
  return readEvaluationLedgerArtifactsWith(
    {
      profile: "gke",
      namespace: "mz-run-917",
      ref: REF,
      gkeArtifactBucket: "moltzap-eval-artifacts",
    },
    operations(files, objects),
  ).pipe(
    Effect.tap((artifacts) => {
      assert.deepStrictEqual(artifacts, ARTIFACTS);
      assert.deepStrictEqual(files, []);
      assert.deepStrictEqual(
        [...objects].sort((left, right) => left.localeCompare(right)),
        [
          `gs://moltzap-eval-artifacts/mz-run-917/ledger/${REF}/completion.json`,
          `gs://moltzap-eval-artifacts/mz-run-917/ledger/${REF}/manifest.json`,
          `gs://moltzap-eval-artifacts/mz-run-917/ledger/${REF}/records.ndjson`,
        ],
      );
    }),
    Effect.provide(NodeContext.layer),
  );
});

test("surfaces an unavailable artifact as an operational read failure", () =>
  readEvaluationLedgerArtifactsWith(
    {
      profile: "local",
      namespace: "mz-run-917",
      ref: REF,
      localArtifacts: "/var/lib/moltzap/artifacts",
    },
    {
      readFile: (identity) =>
        identity.endsWith("/records.ndjson")
          ? Effect.fail("records are unavailable")
          : Effect.succeed(content(identity)),
      readObject: () => Effect.dieMessage("unexpected object read"),
    },
  ).pipe(
    Effect.flip,
    Effect.tap((failure) => {
      assert.instanceOf(failure, EvaluationArtifactReadFailed);
      assert.strictEqual(failure.artifact, "records");
      assert.strictEqual(failure.profile, "local");
    }),
    Effect.provide(NodeContext.layer),
  ));

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- External artifact identity assertions end here. */
