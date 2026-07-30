import { FileSystem } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { LedgerStorageError } from "@moltzap/simulator/ledger";
import { DateTime, Effect, Ref, Schema } from "effect";
import {
  evaluationResultStoreLayer,
  runEvaluationSweep,
} from "../dist/results.js";
import { LedgerAllocationFailedAttempt } from "../dist/sweep.js";

const processArguments = Schema.Tuple(
  Schema.NonEmptyString,
  Schema.NonEmptyString,
);

const program = Effect.gen(function* () {
  const [databasePath, enteredPath] = yield* Schema.decodeUnknown(
    processArguments,
  )(process.argv.slice(2));
  const fileSystem = yield* FileSystem.FileSystem;
  const executions = yield* Ref.make(0);

  yield* runEvaluationSweep((cell) =>
    Ref.getAndUpdate(executions, (count) => count + 1).pipe(
      Effect.flatMap((execution) =>
        execution === 0
          ? DateTime.now.pipe(
              Effect.map((completedAt) =>
                LedgerAllocationFailedAttempt.make({
                  attemptId: cell.attemptId,
                  caseId: cell.casePlan.id,
                  conditionId: cell.conditionPlan.id,
                  sample: cell.sample,
                  startedAt: completedAt,
                  completedAt,
                  failure: LedgerStorageError.make({
                    operation: "allocate",
                    detail: "process-death recovery fixture",
                  }),
                }),
              ),
            )
          : fileSystem
              .writeFileString(enteredPath, `${cell.attemptId}\n`)
              .pipe(Effect.zipRight(Effect.never)),
      ),
    ),
  ).pipe(Effect.provide(evaluationResultStoreLayer(databasePath)));
}).pipe(Effect.provide(NodeContext.layer));

NodeRuntime.runMain(program);
