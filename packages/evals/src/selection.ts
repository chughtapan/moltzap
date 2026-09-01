/** @file Runtime and case selection for evaluation commands. */

import type { NonEmptyReadonlyArray } from "effect/Array";
import { Options } from "@effect/cli";
import { Option, Schema } from "effect";
import type { SimulatorProfile } from "./submission.js";
import {
  type BundledEvaluationCase,
  evaluationCase,
  evaluationCases,
} from "./cases.js";
import { evaluationCaseId, type EvaluationCaseId } from "./model.js";

/** Validated execution options shared by plan and infrastructure assembly. */
export interface EvaluationRunOptions {
  readonly runtime: "all" | "openclaw" | "nanoclaw";
  readonly openclawModel?: string;
  readonly nanoclawModel?: string;
  readonly messagingMode: "shared" | "private";
  readonly profile: SimulatorProfile;
}

/** Values decoded directly from evaluation command-line options. */
export interface EvaluationRunCliOptions {
  readonly runtime: EvaluationRunOptions["runtime"];
  readonly openclawModel: Option.Option<string>;
  readonly nanoclawModel: Option.Option<string>;
  readonly messagingMode: EvaluationRunOptions["messagingMode"];
  readonly profile: SimulatorProfile;
  readonly caseIds: readonly EvaluationCaseId[];
}

/** One command's validated runtime options and ordered case subset. */
export interface EvaluationRunSelection {
  readonly options: EvaluationRunOptions;
  readonly cases: NonEmptyReadonlyArray<BundledEvaluationCase>;
}

/** A command-line selection cannot produce an executable evaluation plan. */
export class EvaluationSelectionInvalid extends Schema.TaggedError<EvaluationSelectionInvalid>()(
  "EvaluationSelectionInvalid",
  { detail: Schema.NonEmptyString },
) {}

const runtimeOption = Options.text("runtime").pipe(
  Options.withSchema(Schema.Literal("all", "openclaw", "nanoclaw")),
  Options.withDefault("all"),
  Options.withDescription("Agent runtime conditions included in the sweep."),
);
const caseOption = Options.text("case").pipe(
  Options.withDescription(
    "Bundled evaluation case ID; repeat this option to select multiple cases.",
  ),
  Options.repeated,
  Options.withSchema(Schema.mutable(Schema.Array(evaluationCaseId))),
);
const openclawModelOption = Options.text("openclaw-model").pipe(
  Options.withSchema(Schema.NonEmptyString),
  Options.withDescription("Exact OpenClaw model ID."),
  Options.optional,
);
const nanoclawModelOption = Options.text("nanoclaw-model").pipe(
  Options.withSchema(Schema.NonEmptyString),
  Options.withDescription("Exact NanoClaw model ID."),
  Options.optional,
);
const messagingModeOption = Options.text("messaging-mode").pipe(
  Options.withSchema(Schema.Literal("shared", "private")),
  Options.withDefault("shared"),
  Options.withDescription("Native host session layout for addressed messages."),
);
const profileOption = Options.text("profile").pipe(
  Options.withSchema(Schema.Literal("local", "gke")),
  Options.withDefault("local"),
  Options.withDescription("Repository-owned Kubernetes execution profile."),
);

/** Options shared by the run and resume commands. */
export const evaluationRunCliOptions = {
  runtime: runtimeOption,
  openclawModel: openclawModelOption,
  nanoclawModel: nanoclawModelOption,
  messagingMode: messagingModeOption,
  profile: profileOption,
  caseIds: caseOption,
} as const;

/**
 * Resolve one command's runtime conditions and exact ordered case subset.
 * @param cliOptions Values decoded directly from the command line.
 * @returns Validated runtime options and selected case definitions.
 */
export function resolveEvaluationRunSelection(
  cliOptions: EvaluationRunCliOptions,
): EvaluationRunSelection {
  const options = {
    runtime: cliOptions.runtime,
    openclawModel: Option.getOrUndefined(cliOptions.openclawModel),
    nanoclawModel: Option.getOrUndefined(cliOptions.nanoclawModel),
    messagingMode: cliOptions.messagingMode,
    profile: cliOptions.profile,
  } as const;
  const diagnostic = runtimeSelectionDiagnostic(options);
  if (diagnostic !== undefined) {
    throw EvaluationSelectionInvalid.make({ detail: diagnostic });
  }
  return {
    options,
    cases: selectedCases(cliOptions.caseIds),
  };
}

/**
 * Return the operator-facing reason one runtime selection is incomplete.
 * @param options Runtime, model, and messaging-mode selection.
 * @param options.runtime Runtime conditions included in the sweep.
 * @param options.openclawModel Exact OpenClaw model when selected.
 * @param options.nanoclawModel Exact NanoClaw model when selected.
 * @param options.messagingMode Native host session layout.
 * @returns A diagnostic, or `undefined` when the selection is executable.
 */
export function runtimeSelectionDiagnostic(options: {
  readonly runtime: EvaluationRunOptions["runtime"];
  readonly openclawModel?: string;
  readonly nanoclawModel?: string;
  readonly messagingMode: EvaluationRunOptions["messagingMode"];
}): string | undefined {
  const selected = new Set(
    options.runtime === "all"
      ? (["openclaw", "nanoclaw"] as const)
      : [options.runtime],
  );
  if (selected.has("openclaw") && options.openclawModel === undefined) {
    return "--openclaw-model is required when --runtime selects OpenClaw";
  }
  if (selected.has("nanoclaw") && options.nanoclawModel === undefined) {
    return "--nanoclaw-model is required when --runtime selects NanoClaw";
  }
  if (selected.has("nanoclaw") && options.messagingMode === "private") {
    return "--messaging-mode private is supported only with --runtime openclaw";
  }
  return undefined;
}

function selectedCases(
  caseIds: readonly EvaluationCaseId[],
): NonEmptyReadonlyArray<BundledEvaluationCase> {
  if (caseIds.length === 0) {
    return evaluationCases;
  }
  const seen = new Set<EvaluationCaseId>();
  const selected: BundledEvaluationCase[] = [];
  for (const caseId of caseIds) {
    if (seen.has(caseId)) {
      throw EvaluationSelectionInvalid.make({
        detail: `--case ${caseId} was selected more than once`,
      });
    }
    const definition = evaluationCase(caseId);
    if (definition === undefined) {
      throw EvaluationSelectionInvalid.make({
        detail: `--case ${caseId} is not in the bundled evaluation catalog`,
      });
    }
    seen.add(caseId);
    selected.push(definition);
  }
  const [first, ...remaining] = selected;
  if (first === undefined) {
    throw EvaluationSelectionInvalid.make({
      detail: "evaluation case selection is empty",
    });
  }
  return [first, ...remaining];
}
