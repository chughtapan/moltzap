/** @file Result-store transaction, resume, and process-failure regression coverage. */

import { Command, FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { assert, describe, it as effectIt } from "@effect/vitest";
import { image } from "@moltzap/simulator/agents";
import { LedgerStorageError } from "@moltzap/simulator/ledger";
import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Exit,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";
import {
  decodeConditionId,
  decodeCriterionId,
  decodeEvaluationCaseId,
  decodeJudgePolicyId,
} from "./model.js";
import {
  createStoredEvaluationReport,
  evaluationResultStoreLayer,
  loadEvaluationReport,
  resumeStoredEvaluationReport,
  runEvaluationSweep,
} from "./results.js";
import {
  CompletedEvaluationReport,
  decodeEvaluationReportId,
  EvaluationCasePlan,
  EvaluationConditionPlan,
  EvaluationReportPlan,
  EvaluationResumeMismatch,
  type EvaluationSweepCell,
  JudgePolicySnapshot,
  LedgerAllocationFailedAttempt,
  LocalEvaluationInfrastructure,
} from "./sweep.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- storage tests pin transaction, resume, and privacy invariants. */

const testImage = Schema.decodeSync(image);

const it = effectIt.scoped;
const liveIt = effectIt.scopedLive;
const caseId = decodeEvaluationCaseId;
const conditionId = decodeConditionId;
const criterionId = decodeCriterionId;
const judgePolicyId = decodeJudgePolicyId;
const reportId = decodeEvaluationReportId;
const effectConditionId = conditionId("effect/v1");
const fixtureRuntimeName = "effect";
const instant = DateTime.unsafeMake(0);

class DeliberateExecutionFailure extends Schema.TaggedError<DeliberateExecutionFailure>()(
  "DeliberateExecutionFailure",
  {
    detail: Schema.NonEmptyString,
  },
) {}

function casePlan(id: string): EvaluationCasePlan {
  return EvaluationCasePlan.make({
    id: caseId(id),
    definitionId: `moltzap.test.${id.toLowerCase()}/v1`,
    name: id,
    description: `Deterministic ${id} test case.`,
    rubric: `Assess ${id}.`,
    criterionIds: [criterionId(`${id}.result/v1`)],
    slices: ["baseline"],
  });
}

function plan(
  first: EvaluationCasePlan,
  ...remaining: readonly EvaluationCasePlan[]
): EvaluationReportPlan {
  return EvaluationReportPlan.make({
    sourceRevision: "test-revision",
    cases: [first, ...remaining],
    conditions: [
      EvaluationConditionPlan.make({
        id: effectConditionId,
        runtimeName: fixtureRuntimeName,
        runtimeConfiguration: { mode: "deterministic" },
      }),
    ],
    judgePolicy: JudgePolicySnapshot.make({
      id: judgePolicyId("test-judge/v1"),
      provider: "test",
      model: "deterministic",
      reasoningEffort: "medium",
      structuredOutput: true,
      tools: "none",
      timeoutMillis: 1_000,
      maxRetries: 2,
    }),
    infrastructure: localInfrastructure("/var/lib/moltzap/artifacts"),
    samplesPerCell: 1,
  });
}

// Every field but the artifact directory is fixed, so a resume mismatch test can
// vary that one field and still submit an otherwise identical plan.
function localInfrastructure(
  artifactDirectory: string,
): LocalEvaluationInfrastructure {
  return LocalEvaluationInfrastructure.make({
    profile: "local",
    controllerImage: testImage(`controller@sha256:${"a".repeat(64)}`),
    nanoclawApplicationImage: testImage(`nanoclaw@sha256:${"c".repeat(64)}`),
    temporalAddress: "127.0.0.1:7233",
    artifactDirectory,
  });
}

function firstPass(
  executed: Ref.Ref<readonly string[]>,
  expected: DeliberateExecutionFailure,
  cell: EvaluationSweepCell,
) {
  return recordExecution(executed, cell).pipe(
    Effect.zipRight(
      cell.casePlan.id === caseId("EVAL-005")
        ? Effect.succeed(allocationFailed(cell))
        : Effect.fail(expected),
    ),
  );
}

function successfulPass(
  executed: Ref.Ref<readonly string[]>,
  cell: EvaluationSweepCell,
) {
  return recordExecution(executed, cell).pipe(
    Effect.as(allocationFailed(cell)),
  );
}

function allocationFailed(
  cell: EvaluationSweepCell,
): LedgerAllocationFailedAttempt {
  return LedgerAllocationFailedAttempt.make({
    attemptId: cell.attemptId,
    caseId: cell.casePlan.id,
    conditionId: effectConditionId,
    sample: cell.sample,
    startedAt: instant,
    completedAt: instant,
    failure: LedgerStorageError.make({
      operation: "allocate",
      detail: "deterministic test failure",
    }),
  });
}

function resultFixture(prefix: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    const databasePath = path.join(directory, "result.sqlite");
    return {
      databasePath,
      directory,
      fileSystem,
    };
  });
}

function assertNoApplicationCheckpoints(
  fileSystem: FileSystem.FileSystem,
  directory: string,
) {
  return fileSystem.readDirectory(directory).pipe(
    Effect.flatMap((entries) =>
      Effect.sync(() => {
        assert.isFalse(
          entries.some(
            (entry) => entry.endsWith(".lock") || entry.endsWith(".tmp"),
          ),
        );
      }),
    ),
  );
}

function recordExecution(
  executed: Ref.Ref<readonly string[]>,
  cell: EvaluationSweepCell,
) {
  return Ref.update(executed, (attempts) => [...attempts, cell.attemptId]);
}

function checkpointResumeTest() {
  return Effect.gen(function* () {
    const fixture = yield* resultFixture("moltzap-evals-resume-");
    const reportPlan = plan(casePlan("EVAL-005"), casePlan("EVAL-006"));
    const executed = yield* Ref.make<readonly string[]>([]);
    const expected = DeliberateExecutionFailure.make({
      detail: "stop after the first committed cell",
    });

    yield* Effect.gen(function* () {
      yield* createStoredEvaluationReport(reportId("resume-test"), reportPlan);
      const firstRunFailure = yield* runEvaluationSweep((cell) =>
        firstPass(executed, expected, cell),
      ).pipe(Effect.flip);
      assert.instanceOf(firstRunFailure, DeliberateExecutionFailure);

      const checkpoint = yield* loadEvaluationReport();
      assert.strictEqual(checkpoint._tag, "InProgressEvaluationReport");
      assert.lengthOf(checkpoint.attempts, 1);
    }).pipe(Effect.provide(evaluationResultStoreLayer(fixture.databasePath)));

    const persisted = yield* Effect.gen(function* () {
      yield* resumeStoredEvaluationReport(reportPlan);
      const completed = yield* runEvaluationSweep((cell) =>
        successfulPass(executed, cell),
      );
      const persisted = yield* loadEvaluationReport();

      assert.instanceOf(completed, CompletedEvaluationReport);
      assert.instanceOf(persisted, CompletedEvaluationReport);
      return persisted;
    }).pipe(Effect.provide(evaluationResultStoreLayer(fixture.databasePath)));

    assert.deepStrictEqual(yield* Ref.get(executed), [
      "resume-test/effect/v1/EVAL-005/001",
      "resume-test/effect/v1/EVAL-006/001",
      "resume-test/effect/v1/EVAL-006/001",
    ]);
    const retained = persisted.attempts[0];
    assert.instanceOf(retained, LedgerAllocationFailedAttempt);
    if (retained instanceof LedgerAllocationFailedAttempt) {
      assert.instanceOf(retained.failure, LedgerStorageError);
    }

    const directoryInfo = yield* fixture.fileSystem.stat(fixture.directory);
    const databaseInfo = yield* fixture.fileSystem.stat(fixture.databasePath);
    assert.strictEqual(directoryInfo.mode & 0o777, 0o700);
    assert.strictEqual(databaseInfo.mode & 0o777, 0o600);
    yield* assertNoApplicationCheckpoints(
      fixture.fileSystem,
      fixture.directory,
    );
  }).pipe(Effect.provide(NodeContext.layer));
}

function awaitFile(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  timeoutDetail: string,
) {
  return fileSystem.exists(filePath).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(10)),
      until: (exists) => exists,
    }),
    Effect.timeoutFail({
      duration: Duration.seconds(30),
      onTimeout: () => new Error(timeoutDetail),
    }),
  );
}

function startCrashFixture(
  fixturePath: string,
  databasePath: string,
  enteredPath: string,
) {
  return Command.make(
    process.execPath,
    fixturePath,
    databasePath,
    enteredPath,
  ).pipe(Command.stdout("inherit"), Command.stderr("inherit"), Command.start);
}

function resumeAfterProcessDeath(
  databasePath: string,
  reportPlan: EvaluationReportPlan,
  executed: Ref.Ref<readonly string[]>,
) {
  return Effect.gen(function* () {
    const checkpoint = yield* loadEvaluationReport();
    assert.strictEqual(checkpoint._tag, "InProgressEvaluationReport");
    assert.lengthOf(checkpoint.attempts, 1);
    yield* resumeStoredEvaluationReport(reportPlan);
    return yield* runEvaluationSweep((cell) => successfulPass(executed, cell));
  }).pipe(Effect.provide(evaluationResultStoreLayer(databasePath)));
}

function processDeathResumeTest() {
  return Effect.gen(function* () {
    const fixture = yield* resultFixture("moltzap-evals-process-death-");
    const reportPlan = plan(casePlan("EVAL-005"), casePlan("EVAL-006"));
    const path = yield* Path.Path;
    const crashFixture = yield* path.fromFileUrl(
      new URL("../test-support/result-store-crash.mjs", import.meta.url),
    );
    const enteredPath = path.join(fixture.directory, "cell-entered");
    const executedAfterCrash = yield* Ref.make<readonly string[]>([]);

    yield* createStoredEvaluationReport(
      reportId("process-death-test"),
      reportPlan,
    ).pipe(Effect.provide(evaluationResultStoreLayer(fixture.databasePath)));
    const child = yield* startCrashFixture(
      crashFixture,
      fixture.databasePath,
      enteredPath,
    );
    yield* awaitFile(
      fixture.fileSystem,
      enteredPath,
      "the crash fixture did not enter its second cell",
    );
    const enteredAttempt = (yield* fixture.fileSystem.readFileString(
      enteredPath,
    )).trim();

    yield* child.kill("SIGKILL");

    const completed = yield* resumeAfterProcessDeath(
      fixture.databasePath,
      reportPlan,
      executedAfterCrash,
    );

    assert.strictEqual(
      enteredAttempt,
      "process-death-test/effect/v1/EVAL-006/001",
    );
    assert.instanceOf(completed, CompletedEvaluationReport);
    assert.lengthOf(completed.attempts, 2);
    assert.deepStrictEqual(yield* Ref.get(executedAfterCrash), [
      "process-death-test/effect/v1/EVAL-006/001",
    ]);
    yield* assertNoApplicationCheckpoints(
      fixture.fileSystem,
      fixture.directory,
    );
  }).pipe(Effect.provide(NodeContext.layer));
}

function resumeMismatchTest() {
  return Effect.gen(function* () {
    const fixture = yield* resultFixture("moltzap-evals-mismatch-");
    const reportPlan = plan(casePlan("EVAL-005"));
    yield* Effect.gen(function* () {
      yield* createStoredEvaluationReport(
        reportId("resume-mismatch-test"),
        reportPlan,
      );
      const changedPlan = EvaluationReportPlan.make({
        sourceRevision: reportPlan.sourceRevision,
        cases: reportPlan.cases,
        conditions: [
          EvaluationConditionPlan.make({
            id: effectConditionId,
            runtimeName: fixtureRuntimeName,
            runtimeConfiguration: { mode: "changed" },
          }),
        ],
        judgePolicy: reportPlan.judgePolicy,
        infrastructure: reportPlan.infrastructure,
        samplesPerCell: reportPlan.samplesPerCell,
      });
      const mismatch = yield* resumeStoredEvaluationReport(changedPlan).pipe(
        Effect.flip,
      );

      assert.instanceOf(mismatch, EvaluationResumeMismatch);
      assert.strictEqual(mismatch.field, "runtimeConfigurations");
    }).pipe(Effect.provide(evaluationResultStoreLayer(fixture.databasePath)));
  }).pipe(Effect.provide(NodeContext.layer));
}

function infrastructureResumeMismatchTest() {
  return Effect.gen(function* () {
    const fixture = yield* resultFixture("moltzap-evals-infrastructure-");
    const reportPlan = plan(casePlan("EVAL-005"));
    yield* Effect.gen(function* () {
      yield* createStoredEvaluationReport(
        reportId("infrastructure-mismatch-test"),
        reportPlan,
      );
      const changedPlan = EvaluationReportPlan.make({
        sourceRevision: reportPlan.sourceRevision,
        cases: reportPlan.cases,
        conditions: reportPlan.conditions,
        judgePolicy: reportPlan.judgePolicy,
        infrastructure: localInfrastructure("/var/lib/moltzap/other-artifacts"),
        samplesPerCell: reportPlan.samplesPerCell,
      });
      const mismatch = yield* resumeStoredEvaluationReport(changedPlan).pipe(
        Effect.flip,
      );

      assert.instanceOf(mismatch, EvaluationResumeMismatch);
      assert.strictEqual(mismatch.field, "infrastructure");
    }).pipe(Effect.provide(evaluationResultStoreLayer(fixture.databasePath)));
  }).pipe(Effect.provide(NodeContext.layer));
}

function uncommittedCallbackTest(
  prefix: string,
  callback: (
    cell: EvaluationSweepCell,
  ) => Effect.Effect<LedgerAllocationFailedAttempt, unknown>,
) {
  return Effect.gen(function* () {
    const fixture = yield* resultFixture(prefix);
    return yield* Effect.gen(function* () {
      yield* createStoredEvaluationReport(
        reportId(`${prefix}report`),
        plan(casePlan("EVAL-005")),
      );
      const exit = yield* runEvaluationSweep(callback).pipe(Effect.exit);
      const report = yield* loadEvaluationReport();
      assert.lengthOf(report.attempts, 0);
      return exit;
    }).pipe(Effect.provide(evaluationResultStoreLayer(fixture.databasePath)));
  }).pipe(Effect.provide(NodeContext.layer));
}

const PROCESS_DEATH_TIMEOUT_MS = 45_000;

describe("evaluation result storage", () => {
  // Committing a cell drives a real SQLite bundle, whose retry paths sleep on
  // the live clock. A virtual clock would freeze such a sleep forever, so this
  // case observes real time even though it never waits on a deadline itself.
  liveIt(
    "commits each terminal cell and resumes without rerunning it",
    checkpointResumeTest,
  );
  liveIt(
    "keeps committed cells and resumes after process death",
    processDeathResumeTest,
    PROCESS_DEATH_TIMEOUT_MS,
  );
  it(
    "rejects a resume when immutable runtime configuration changed",
    resumeMismatchTest,
  );
  it(
    "rejects a resume when the selected infrastructure changed",
    infrastructureResumeMismatchTest,
  );
  it("rolls back a typed callback failure", () =>
    uncommittedCallbackTest("callback-failure-", () =>
      Effect.fail(
        DeliberateExecutionFailure.make({
          detail: "deliberate callback failure",
        }),
      ),
    ).pipe(
      Effect.tap((exit) => {
        assert.isTrue(
          Exit.isFailure(exit) &&
            Option.isSome(Cause.failureOption(exit.cause)),
        );
      }),
    ));
  it("rolls back a callback defect", () =>
    uncommittedCallbackTest("callback-defect-", () =>
      Effect.dieMessage("deliberate callback defect"),
    ).pipe(
      Effect.tap((exit) => {
        assert.isTrue(
          Exit.isFailure(exit) && Option.isSome(Cause.dieOption(exit.cause)),
        );
      }),
    ));
  it("rolls back caller interruption", () =>
    uncommittedCallbackTest("callback-interrupt-", () => Effect.interrupt).pipe(
      Effect.tap((exit) => {
        assert.isTrue(Exit.isInterrupted(exit));
      }),
    ));
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- storage invariant assertions end here. */
