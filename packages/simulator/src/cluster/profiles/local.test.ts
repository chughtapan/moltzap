/** @file Local profile validation, codec, context propagation, and submission regressions. */

import { assert, effect as test } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { RunControllerResult } from "../reclaim.js";
import type { RunTemporalSocietyOptions } from "../temporal.js";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
} from "../../ledger/schema.js";
import { CompletedLedgerReceipt } from "../../run/execute.js";
import { programFinishedSummary } from "../controller/summary.js";
import {
  decodeKubernetesExecutionProfile,
  encodeKubernetesExecutionProfile,
} from "../profile.js";
import {
  DEFAULT_LOCAL_TASK_QUEUE,
  type RunEnvironment,
  RunSubmissionError,
  SUBMIT_STAGE,
  SubmitOperations,
  type SubmitOperationsService,
} from "../submit.js";
import { runLocalSociety } from "./local.js";

const DIGEST = "a".repeat(64);
const CONTROLLER_IMAGE = `moltzap-controller@sha256:${DIGEST}`;
const UUID = "12345678-1234-4abc-8def-1234567890ab";
const MODULE_SOURCE = "export const runSpec = {};";
const KUBE_CONTEXT = "kind-moltzap-isolated";
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

const environment: RunEnvironment = Object.freeze({
  MOLTZAP_CONTROLLER_IMAGE: CONTROLLER_IMAGE,
  MOLTZAP_TEMPORAL_ADDRESS: "127.0.0.1:7233",
  OPENAI_API_KEY: "openai-test-credential",
});

function operations(
  observe?: (options: RunTemporalSocietyOptions) => void,
): SubmitOperationsService {
  return {
    readTextFile: () => Effect.succeed(MODULE_SOURCE),
    randomUuid: () => UUID,
    runTemporalSociety: (options) => {
      observe?.(options);
      return Promise.resolve(CONTROLLER_RESULT);
    },
  };
}

function submit(
  args: readonly string[],
  environment: RunEnvironment,
  operations: SubmitOperationsService,
) {
  return runLocalSociety(args, environment).pipe(
    Effect.provideService(SubmitOperations, operations),
  );
}

test("loads one module and sends it through one Temporal workflow", () =>
  Effect.gen(function* () {
    let observed: RunTemporalSocietyOptions | undefined;
    const result = yield* submit(
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

test("carries an explicitly selected kube context into the local profile", () =>
  Effect.gen(function* () {
    let observed: RunTemporalSocietyOptions | undefined;
    yield* submit(
      ["./experiment.mjs"],
      { ...environment, MOLTZAP_KUBE_CONTEXT: KUBE_CONTEXT },
      operations((options) => {
        observed = options;
      }),
    );

    assert.deepStrictEqual(observed?.executionProfile, {
      kind: "local",
      kubeContext: KUBE_CONTEXT,
    });
  }));

test("round-trips the selected local context through the execution profile codec", () =>
  Effect.sync(() => {
    const profile = { kind: "local", kubeContext: KUBE_CONTEXT } as const;

    assert.deepStrictEqual(
      decodeKubernetesExecutionProfile(
        encodeKubernetesExecutionProfile(profile),
      ),
      profile,
    );
  }));

test("rejects an explicitly empty kube context before reading the experiment", () =>
  Effect.gen(function* () {
    let reads = 0;
    const failure = yield* submit(
      ["./experiment.mjs"],
      { ...environment, MOLTZAP_KUBE_CONTEXT: "" },
      {
        ...operations(),
        readTextFile: () => {
          reads += 1;
          return Effect.succeed(MODULE_SOURCE);
        },
      },
    ).pipe(Effect.flip);

    assert.instanceOf(failure, RunSubmissionError);
    assert.strictEqual(failure.stage, SUBMIT_STAGE.configuration);
    assert.strictEqual(reads, 0);
  }));

test("rejects a mutable image before reading the experiment", () =>
  Effect.gen(function* () {
    let reads = 0;
    const failure = yield* submit(
      ["./experiment.mjs"],
      { MOLTZAP_CONTROLLER_IMAGE: "moltzap-controller:latest" },
      {
        ...operations(),
        readTextFile: () => {
          reads += 1;
          return Effect.succeed("");
        },
      },
    ).pipe(Effect.flip);

    assert.instanceOf(failure, RunSubmissionError);
    assert.strictEqual(failure.stage, SUBMIT_STAGE.configuration);
    assert.strictEqual(reads, 0);
  }));

test("sanitizes module and Temporal failures", () =>
  Effect.gen(function* () {
    const moduleFailure = yield* submit(["./experiment.mjs"], environment, {
      ...operations(),
      readTextFile: () =>
        Effect.fail(
          new RunSubmissionError({
            stage: SUBMIT_STAGE.module,
            detail: "module-secret",
          }),
        ),
    }).pipe(Effect.flip);
    assert.strictEqual(moduleFailure.stage, SUBMIT_STAGE.module);
    assert.notInclude(moduleFailure.message, "module-secret");

    const temporalFailure = yield* submit(["./experiment.mjs"], environment, {
      ...operations(),
      runTemporalSociety: () => Promise.reject(new Error("temporal-secret")),
    }).pipe(Effect.flip);
    assert.strictEqual(temporalFailure.stage, SUBMIT_STAGE.execution);
    assert.notInclude(temporalFailure.message, "temporal-secret");
  }));
