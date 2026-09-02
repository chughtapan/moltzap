/** @file Repository-local Kubernetes submission for one generated evaluation cell. */

import type { Image } from "@moltzap/simulator/agents";
import { Command, FileSystem, Path } from "@effect/platform";
import {
  ProfileRunResult,
  type SimulatorDefinitionId,
} from "@moltzap/simulator";
import { Effect, Either, Schema } from "effect";
import type {
  EvaluationCaseId,
  EvaluationConditionId,
  EvaluationConditionName,
} from "./model.js";

/** Repository-owned Kubernetes profile selected for an evaluation sweep. */
export type SimulatorProfile = "local" | "gke";

/**
 * Path segments, below the simulator package root, of the `moltzap-sim`
 * executable.
 *
 * The submitter spawns this file by path rather than importing it, so nothing
 * typechecks the spelling. It is exported so a drift canary can compare it
 * against the `bin` entry in the simulator's own manifest.
 */
export const SIMULATOR_EXECUTABLE = "bin/moltzap-sim";

/**
 * The command line that submits one module through one profile.
 * @param profile Kubernetes profile the executable routes to.
 * @param modulePath Absolute path of the generated RunSpec module.
 * @returns Arguments after the executable name.
 */
export function simulatorRunArguments(
  profile: SimulatorProfile,
  modulePath: string,
): readonly string[] {
  return ["run", "--profile", profile, modulePath];
}

/**
 * The controller's own account of why one submission failed.
 * @param submission Decoded submitter result for one cell.
 * @returns The diagnostic the submitter published, or undefined when it carried none.
 */
export function submissionDiagnostic(
  submission: ProfileRunResult,
): string | undefined {
  const diagnostic =
    submission.result.exitCode === 1 ? submission.result.diagnostic : undefined;
  return diagnostic === undefined || diagnostic.length === 0
    ? undefined
    : diagnostic;
}

/** A repository-local cell could not be submitted or decoded. */
export class EvaluationSubmissionFailed extends Schema.TaggedError<EvaluationSubmissionFailed>()(
  "EvaluationSubmissionFailed",
  {
    stage: Schema.Literal("module", "command", "result"),
    detail: Schema.NonEmptyString,
  },
) {}

interface SubmissionCondition {
  readonly id: EvaluationConditionId;
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
  readonly messagingMode: "shared" | "private";
  readonly openclawApplicationImage?: Image;
  readonly nanoclawApplicationImage?: Image;
  readonly runtimeStartupTimeoutMillis: number;
  /** How long the cell may wait in the profile's queue behind other runs. */
  readonly admissionTimeoutMillis: number;
  readonly peerObservationTimeoutMillis: number;
  readonly caseTimeoutMillis: number;
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
    'import { controllerServicesFromEnvironment, supportImageFromEnvironment } from "/opt/moltzap/dist/cluster/controller/services.js";',
    `const definition = evaluationCase(${literal(input.caseId)});`,
    `if (definition === undefined || definition.definitionId !== ${literal(input.definitionId)}) throw new Error("evaluation case definition is unavailable");`,
    `const condition = ${condition};`,
    "export const runSpec = evaluationCellRunSpec({",
    "  definition,",
    "  condition,",
    `  attemptId: ${literal(input.attemptId)},`,
    "  peerApplicationImage: supportImageFromEnvironment(),",
    "  cluster: controllerServicesFromEnvironment(),",
    "});",
    "",
  ].join("\n");
}

const decodeResultLine = Schema.decodeUnknownEither(
  Schema.parseJson(ProfileRunResult),
);

/**
 * Decode the final result line the simulator's submitter printed.
 *
 * Exported so the stdout contract can be pinned directly: the submitter is a
 * spawned process, so nothing else in this package would notice the two sides
 * disagreeing until a live sweep produced an undecodable line.
 *
 * @param output Complete captured stdout of one submitter process.
 * @returns The decoded result, from the last line that is one.
 */
export function decodeSubmissionOutput(
  output: string,
): Effect.Effect<ProfileRunResult, EvaluationSubmissionFailed> {
  const lines = output.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line.length === 0) {
      continue;
    }
    const decoded = decodeResultLine(line, { onExcessProperty: "error" });
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
      const executable = path.join(
        input.workspaceRoot,
        "packages",
        "simulator",
        SIMULATOR_EXECUTABLE,
      );
      const command = Command.make(
        "node",
        executable,
        ...simulatorRunArguments(input.profile, modulePath),
      ).pipe(
        Command.env({
          MOLTZAP_STARTUP_TIMEOUT_MS: String(input.runtimeStartupTimeoutMillis),
          MOLTZAP_ADMISSION_TIMEOUT_MS: String(input.admissionTimeoutMillis),
        }),
        Command.stderr("inherit"),
      );
      const output = yield* Command.string(command).pipe(
        Effect.mapError(commandFailure),
      );
      return yield* decodeSubmissionOutput(output);
    }),
  ).pipe(Effect.withSpan("submitEvaluationCell"));
}

function conditionExpression(input: SubmitEvaluationCellInput): string {
  const runtime = [
    `startupTimeout: Duration.millis(${String(input.runtimeStartupTimeoutMillis)})`,
    `modelId: ${literal(input.condition.modelId)}`,
  ];
  const execution = [
    `peerObservationTimeout: Duration.millis(${String(input.peerObservationTimeoutMillis)})`,
    `caseTimeout: Duration.millis(${String(input.caseTimeoutMillis)})`,
  ];
  // Total over the conditions that exist, so the generated module never has to
  // carry a throw for a condition the caller could not have named.
  const byCondition: Readonly<Record<EvaluationConditionName, () => string>> = {
    "openclaw/v2": () => {
      if (input.openclawApplicationImage === undefined) {
        throw EvaluationSubmissionFailed.make({
          stage: "module",
          detail:
            "OpenClaw evaluation cells require an OpenClaw application image",
        });
      }
      return `openClawEvaluationCondition({ runtime: { ${runtime.join(", ")}, applicationImage: ${literal(input.openclawApplicationImage)}, messagingMode: ${literal(input.messagingMode)} }, execution: { ${execution.join(", ")} } })`;
    },
    "nanoclaw/v2": () => {
      if (input.nanoclawApplicationImage === undefined) {
        throw EvaluationSubmissionFailed.make({
          stage: "module",
          detail:
            "NanoClaw evaluation cells require a NanoClaw application image",
        });
      }
      return `nanoclawEvaluationCondition({ runtime: { ${runtime.join(", ")}, applicationImage: ${literal(input.nanoclawApplicationImage)} }, execution: { ${execution.join(", ")} } })`;
    },
  };
  // Indexing needs the plain spelling; the brand is not part of the key set.
  const condition: EvaluationConditionName = input.condition.id;
  return byCondition[condition]();
}

function literal(value: string): string {
  return Schema.encodeSync(Schema.parseJson(Schema.String))(value);
}

function commandFailure(cause: unknown): EvaluationSubmissionFailed {
  return EvaluationSubmissionFailed.make({
    stage: "command",
    detail: String(cause).trim() || "simulator submitter failed",
  });
}
