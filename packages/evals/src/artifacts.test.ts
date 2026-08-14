/** @file Contract tests for exact local and Cloud Storage artifact retrieval. */

import { Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ledgerRef } from "@moltzap/simulator/ledger";
import { Effect, Option, Schema } from "effect";
import {
  evaluationArtifactBucket,
  evaluationArtifactLocation,
  type EvaluationArtifactLocation,
  type EvaluationArtifactOperations,
  EvaluationArtifactReadFailed,
  type EvaluationArtifactStorage,
  localArtifactRoot,
  readEvaluationLedgerArtifactsWith,
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

const localArtifactStorage = Effect.gen(function* () {
  const path = yield* Path.Path;
  return {
    profile: "local",
    root: Option.getOrThrow(
      localArtifactRoot(path, "/var/lib/moltzap/artifacts"),
    ),
  } as const satisfies EvaluationArtifactStorage;
});

const gkeStorage = {
  profile: "gke",
  bucket: Option.getOrThrow(evaluationArtifactBucket("moltzap-eval-artifacts")),
} as const satisfies EvaluationArtifactStorage;

function locate(storage: EvaluationArtifactStorage) {
  return Option.getOrThrow(
    evaluationArtifactLocation(storage, "mz-run-917", REF),
  );
}

test("reads the exact local namespace ledger artifact set", () => {
  const files: string[] = [];
  const objects: string[] = [];
  return localArtifactStorage.pipe(
    Effect.flatMap((storage) =>
      readEvaluationLedgerArtifactsWith(
        locate(storage),
        operations(files, objects),
      ),
    ),
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
    locate(gkeStorage),
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
  localArtifactStorage.pipe(
    Effect.flatMap((storage) =>
      readEvaluationLedgerArtifactsWith(locate(storage), {
        readFile: (identity) =>
          identity.endsWith("/records.ndjson")
            ? Effect.fail("records are unavailable")
            : Effect.succeed(content(identity)),
        readObject: () => Effect.dieMessage("unexpected object read"),
      }),
    ),
    Effect.flip,
    Effect.tap((failure) => {
      assert.instanceOf(failure, EvaluationArtifactReadFailed);
      assert.strictEqual(failure.artifact, "records");
      assert.strictEqual(failure.profile, "local");
    }),
    Effect.provide(NodeContext.layer),
  ));

test("refuses a relative artifact root before any run is addressed", () =>
  Path.Path.pipe(
    Effect.tap((path) => {
      assert.isTrue(Option.isNone(localArtifactRoot(path, "artifacts")));
      assert.isTrue(Option.isSome(localArtifactRoot(path, "/artifacts")));
    }),
    Effect.provide(NodeContext.layer),
  ));

test("refuses an artifact bucket Cloud Storage would not name", () =>
  Effect.sync(() => {
    assert.isTrue(Option.isNone(evaluationArtifactBucket("Moltzap-Artifacts")));
    assert.isTrue(Option.isNone(evaluationArtifactBucket("moltzap/artifacts")));
    assert.isTrue(Option.isSome(evaluationArtifactBucket("moltzap-artifacts")));
  }));

test("refuses a ledger ref that is not one storage path segment", () =>
  Effect.sync(() => {
    const forged = Schema.decodeSync(ledgerRef)("../outside");
    const located: Option.Option<EvaluationArtifactLocation> =
      evaluationArtifactLocation(gkeStorage, "mz-run-917", forged);
    assert.isTrue(Option.isNone(located));
  }));

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- External artifact identity assertions end here. */

// @agent-code-guard/regression-only: the identities are fixed external contracts and each rejection example pins one candidate the constructors must refuse before a run is addressed
