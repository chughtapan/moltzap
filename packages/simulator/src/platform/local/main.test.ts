import { assert, effect as test } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CompletedLedgerReceipt } from "../../kernel/run.js";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
} from "../../ledger/model.js";
import { programFinishedSummary } from "../controller/summary.js";
import type { RunControllerResult } from "../temporal/contract.js";
import type { RunTemporalSocietyOptions } from "../temporal/run.js";
import {
  LocalRunFailed,
  LOCAL_RUN_STAGE,
  DEFAULT_LOCAL_TASK_QUEUE,
  runLocalSocietyWith,
  type LocalRunEnvironment,
  type LocalRunOperations,
} from "./main.js";

const DIGEST = "a".repeat(64);
const CONTROLLER_IMAGE = `moltzap-controller@sha256:${DIGEST}`;
const UUID = "12345678-1234-4abc-8def-1234567890ab";
const MODULE_SOURCE = "export const runSpec = {};";
const LEDGER_DIGEST = Schema.decodeSync(ledgerDigest)("b".repeat(64));
const CONTROLLER_RESULT: RunControllerResult = {
  exitCode: 0,
  summary: programFinishedSummary(
    CompletedLedgerReceipt.make({
      ledger: Schema.decodeSync(ledgerRef)("local-main-test-ledger"),
      completion: LedgerCompletion.make({
        ledgerFormatVersion: 1,
        runId: "local-main-test-run",
        recordCount: 0,
        artifacts: {
          manifest: LEDGER_DIGEST,
          records: LEDGER_DIGEST,
        },
      }),
    }),
  ),
};

const environment: LocalRunEnvironment = Object.freeze({
  MOLTZAP_CONTROLLER_IMAGE: CONTROLLER_IMAGE,
  MOLTZAP_TEMPORAL_ADDRESS: "127.0.0.1:7233",
  OPENAI_API_KEY: "openai-test-credential",
});

function operations(
  observe?: (options: RunTemporalSocietyOptions) => void,
): LocalRunOperations {
  return {
    readExperimentModule: () => Effect.succeed(MODULE_SOURCE),
    randomUuid: () => UUID,
    runTemporalSociety: (options) => {
      observe?.(options);
      return Promise.resolve(CONTROLLER_RESULT);
    },
  };
}

test("loads one module and sends it through one Temporal workflow", () =>
  Effect.gen(function* () {
    let observed: RunTemporalSocietyOptions | undefined;
    const result = yield* runLocalSocietyWith(
      ["./experiment.mjs"],
      environment,
      operations((options) => {
        observed = options;
      }),
    );

    assert.strictEqual(result.runId, `mz-${UUID.replaceAll("-", "")}`);
    assert.strictEqual(result.namespace, result.runId);
    assert.strictEqual(observed?.workflowId, result.runId);
    assert.strictEqual(observed?.taskQueue, DEFAULT_LOCAL_TASK_QUEUE);
    assert.deepStrictEqual(observed?.executionProfile, { kind: "local" });
    assert.strictEqual(observed?.input.experimentModule, MODULE_SOURCE);
    assert.strictEqual(observed?.input.controllerImage, CONTROLLER_IMAGE);
    assert.strictEqual(observed?.input.supportImage, CONTROLLER_IMAGE);
    assert.deepStrictEqual(observed?.input.runtimeCredentials, {
      OPENAI_API_KEY: "openai-test-credential",
    });
  }));

test("rejects a mutable image before reading the experiment", () =>
  Effect.gen(function* () {
    let reads = 0;
    const failure = yield* runLocalSocietyWith(
      ["./experiment.mjs"],
      { MOLTZAP_CONTROLLER_IMAGE: "moltzap-controller:latest" },
      {
        ...operations(),
        readExperimentModule: () => {
          reads += 1;
          return Effect.succeed("");
        },
      },
    ).pipe(Effect.flip);

    assert.instanceOf(failure, LocalRunFailed);
    assert.strictEqual(failure.stage, LOCAL_RUN_STAGE.configuration);
    assert.strictEqual(reads, 0);
  }));

test("sanitizes module and Temporal failures", () =>
  Effect.gen(function* () {
    const moduleFailure = yield* runLocalSocietyWith(
      ["./experiment.mjs"],
      environment,
      {
        ...operations(),
        readExperimentModule: () =>
          Effect.fail(
            new LocalRunFailed({
              stage: LOCAL_RUN_STAGE.module,
              detail: "module-secret",
            }),
          ),
      },
    ).pipe(Effect.flip);
    assert.strictEqual(moduleFailure.stage, LOCAL_RUN_STAGE.module);
    assert.notInclude(moduleFailure.message, "module-secret");

    const temporalFailure = yield* runLocalSocietyWith(
      ["./experiment.mjs"],
      environment,
      {
        ...operations(),
        runTemporalSociety: () => Promise.reject(new Error("temporal-secret")),
      },
    ).pipe(Effect.flip);
    assert.strictEqual(temporalFailure.stage, LOCAL_RUN_STAGE.execution);
    assert.notInclude(temporalFailure.message, "temporal-secret");
  }));
