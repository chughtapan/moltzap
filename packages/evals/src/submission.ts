/** @file Repository-local Kubernetes submission for one generated evaluation cell. */

import { Command, FileSystem, Path } from "@effect/platform";
import {
  CompletedLedgerReceipt,
  LedgerReceipt,
  type SimulatorDefinitionId,
} from "@moltzap/simulator";
import type { Image } from "@moltzap/simulator/agents";
import { Effect, Either, Schema } from "effect";
import type { ConditionId, EvaluationCaseId } from "./model.js";

/** Repository-owned Kubernetes profile selected for an evaluation sweep. */
export type SimulatorProfile = "local" | "gke";

const programFinishedSummary = Schema.Struct({
  _tag: Schema.Literal("ProgramFinished"),
  receipt: CompletedLedgerReceipt,
});
const runInfrastructureFailedSummary = Schema.Struct({
  _tag: Schema.Literal("ClusterLost"),
  receipt: LedgerReceipt,
});
const ledgerAllocationFailedSummary = Schema.Struct({
  _tag: Schema.Literal("LedgerAllocationFailed"),
});
const evaluationSubmissionResult = Schema.Struct({
  runId: Schema.NonEmptyString,
  namespace: Schema.NonEmptyString,
  result: Schema.Union(
    Schema.Struct({
      exitCode: Schema.Literal(0),
      summary: programFinishedSummary,
    }),
    Schema.Struct({
      exitCode: Schema.Literal(1),
      summary: Schema.Union(
        runInfrastructureFailedSummary,
        ledgerAllocationFailedSummary,
      ),
    }),
  ),
});
/** Decoded result printed by the simulator's local or GKE submitter. */
export type EvaluationSubmissionResult = typeof evaluationSubmissionResult.Type;

/** A repository-local cell could not be submitted or decoded. */
export class EvaluationSubmissionFailed extends Schema.TaggedError<EvaluationSubmissionFailed>()(
  "EvaluationSubmissionFailed",
  {
    stage: Schema.Literal("module", "command", "result"),
    detail: Schema.NonEmptyString,
  },
) {}

interface SubmissionCondition {
  readonly id: ConditionId;
  readonly modelId: string;
}

/** Complete host facts used to generate and submit one controller module. */
export interface SubmitEvaluationCellInput {
  readonly workspaceRoot: string;
  readonly profile: SimulatorProfile;
  readonly caseId: EvaluationCaseId;
  readonly definitionId: SimulatorDefinitionId;
  readonly attemptId: string;
  readonly condition: SubmissionCondition;
  readonly peerApplicationImage: Image;
  readonly nanoclawApplicationImage: Image;
  readonly runtimeStartupTimeoutMillis: number;
  readonly peerObservationTimeoutMillis: number;
  readonly caseTimeoutMillis: number;
}

function literal(value: string): string {
  return Schema.encodeSync(Schema.parseJson(Schema.String))(value);
}

function conditionExpression(input: SubmitEvaluationCellInput): string {
  const shared = [
    `startupTimeout: Duration.millis(${String(input.runtimeStartupTimeoutMillis)})`,
    `modelId: ${literal(input.condition.modelId)}`,
  ];
  const execution = [
    `peerObservationTimeout: Duration.millis(${String(input.peerObservationTimeoutMillis)})`,
    `caseTimeout: Duration.millis(${String(input.caseTimeoutMillis)})`,
  ];
  if (input.condition.id === "openclaw/v2") {
    return `openClawEvaluationCondition({ runtime: { ${shared.join(", ")} }, execution: { ${execution.join(", ")} } })`;
  }
  if (input.condition.id === "nanoclaw/v2") {
    return `nanoclawEvaluationCondition({ runtime: { ${shared.join(", ")}, applicationImage: ${literal(input.nanoclawApplicationImage)}, autoRegisterConversations: true }, execution: { ${execution.join(", ")} } })`;
  }
  const unsupported = `unsupported evaluation condition ${input.condition.id}`;
  return `(() => { throw new Error(${literal(unsupported)}); })()`;
}

/**
 * Render the only module source admitted by the evaluation submitter.
 * @param input Exact case, condition, image, and timeout bindings.
 * @returns A closed ESM module exporting one cell RunSpec.
 */
export function evaluationControllerModule(
  input: SubmitEvaluationCellInput,
): string {
  const condition = conditionExpression(input);
  return [
    'import { Duration } from "effect";',
    'import { evaluationCase } from "/opt/moltzap/node_modules/@moltzap/evals/dist/cases.js";',
    'import { evaluationCellRunSpec, nanoclawEvaluationCondition, openClawEvaluationCondition } from "/opt/moltzap/node_modules/@moltzap/evals/dist/execution.js";',
    'import { controllerServicesFromEnvironment } from "/opt/moltzap/dist/cluster/controller/services.js";',
    `const definition = evaluationCase(${literal(input.caseId)});`,
    `if (definition === undefined || definition.definitionId !== ${literal(input.definitionId)}) throw new Error("evaluation case definition is unavailable");`,
    `const condition = ${condition};`,
    "export const runSpec = evaluationCellRunSpec({",
    "  definition,",
    "  condition,",
    `  attemptId: ${literal(input.attemptId)},`,
    `  peerApplicationImage: ${literal(input.peerApplicationImage)},`,
    "  cluster: controllerServicesFromEnvironment(),",
    "});",
    "",
  ].join("\n");
}

function commandFailure(cause: unknown): EvaluationSubmissionFailed {
  return EvaluationSubmissionFailed.make({
    stage: "command",
    detail: String(cause).trim() || "simulator submitter failed",
  });
}

function decodeSubmissionOutput(
  output: string,
): Effect.Effect<EvaluationSubmissionResult, EvaluationSubmissionFailed> {
  const lines = output.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line.length === 0) {
      continue;
    }
    const decoded = Schema.decodeUnknownEither(
      Schema.parseJson(evaluationSubmissionResult),
    )(line, { onExcessProperty: "error" });
    const result = Either.getOrUndefined(decoded);
    if (result !== undefined) {
      return Effect.succeed(result);
    }
  }
  return Effect.fail(
    EvaluationSubmissionFailed.make({
      stage: "result",
      detail: "simulator submitter printed no valid final result",
    }),
  );
}

/**
 * Submit one generated module through the existing simulator local/GKE CLI.
 * @param input Exact generated-cell submission facts.
 * @returns The decoded coarse result and run namespace.
 */
export function submitEvaluationCell(input: SubmitEvaluationCellInput) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "moltzap-eval-cell-",
      });
      const modulePath = path.join(directory, "main.mjs");
      const source = yield* Effect.try({
        try: () => evaluationControllerModule(input),
        catch: (cause) =>
          EvaluationSubmissionFailed.make({
            stage: "module",
            detail:
              String(cause).trim() || "controller module generation failed",
          }),
      });
      yield* fileSystem.writeFileString(modulePath, source);
      const simulatorRoot = path.join(
        input.workspaceRoot,
        "packages",
        "simulator",
      );
      const entrypoint = path.join(
        simulatorRoot,
        "dist",
        "platform",
        input.profile,
        "main.js",
      );
      const command = Command.make("node", entrypoint, modulePath).pipe(
        Command.workingDirectory(simulatorRoot),
        Command.stderr("inherit"),
      );
      const output = yield* Command.string(command).pipe(
        Effect.mapError(commandFailure),
      );
      return yield* decodeSubmissionOutput(output);
    }),
  ).pipe(Effect.withSpan("submitEvaluationCell"));
}
