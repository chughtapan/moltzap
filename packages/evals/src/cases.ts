/** @file The ordered code-first catalog of bundled behavioral evaluations. */

import type { Content } from "@moltzap/client";
import type { SimulatorDefinitionId } from "@moltzap/simulator";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { Array as Arr, Effect, type Option } from "effect";
import {
  type CriterionDecided,
  type CriterionId,
  decodeCriterionId,
  decodeEvaluationCaseId,
  type EvaluationCaseId,
  EvaluationCriterion,
  type EvaluationEvidenceId,
  type EvaluationSlice,
  NeedsJudge,
} from "./model.js";

/** Stable roster name of the runtime whose behavior is evaluated. */
export const TARGET_AGENT_NAME = "evaluation-target";

type CriterionDecision = CriterionDecided | NeedsJudge;

interface CriterionEvidenceItem {
  readonly evidenceId: EvaluationEvidenceId;
  readonly source: "gateway";
  readonly parts: Content;
}

/** Minimal ordered evidence exposed to deterministic criterion code. */
export interface CriterionEvidence {
  readonly selected: NonEmptyReadonlyArray<CriterionEvidenceItem>;
}

/** One code-defined behavioral question and its deterministic first pass. */
export interface CriterionDefinition {
  readonly criterion: EvaluationCriterion;
  readonly decide: (evidence: CriterionEvidence) => CriterionDecision;
}

/** Capabilities supplied to one code-defined case program. */
export interface EvaluationCaseProgramContext<Failure> {
  readonly instruct: (
    message: string,
  ) => Effect.Effect<Option.Option<EvaluationEvidenceId>, Failure>;
  readonly selectPrincipalOutput: (
    output: Option.Option<EvaluationEvidenceId>,
  ) => Effect.Effect<EvaluationEvidenceId, Failure>;
}

type EvaluationCaseProgram = <Failure>(
  context: EvaluationCaseProgramContext<Failure>,
) => Effect.Effect<EvaluationEvidenceId, Failure>;

/** Immutable case information consumed by plans, grading, and reports. */
export interface EvaluationCaseMetadata {
  readonly id: EvaluationCaseId;
  readonly definitionId: SimulatorDefinitionId;
  readonly name: string;
  readonly description: string;
  readonly rubric: string;
  readonly slices: NonEmptyReadonlyArray<EvaluationSlice>;
  readonly criteria: NonEmptyReadonlyArray<CriterionDefinition>;
}

/** Metadata plus the executable native-gateway policy. */
export interface EvaluationCaseDefinition extends EvaluationCaseMetadata {
  readonly program: EvaluationCaseProgram;
}

function finalSelection(evidence: CriterionEvidence): CriterionEvidenceItem {
  return Arr.lastNonEmpty(evidence.selected);
}

function semantic(
  id: CriterionId,
  name: string,
  question: string,
): CriterionDefinition {
  const criterion = EvaluationCriterion.make({ id, name, question });
  return {
    criterion,
    decide: (evidence) => {
      finalSelection(evidence);
      return NeedsJudge.make({ criterionId: id, question });
    },
  };
}

function freezeNonEmpty<Value>(
  values: NonEmptyReadonlyArray<Value>,
): NonEmptyReadonlyArray<Value> {
  const [first, ...remaining] = values;
  return Object.freeze([first, ...remaining]);
}

function freezeCriterion(definition: CriterionDefinition): CriterionDefinition {
  return Object.freeze({
    criterion: Object.freeze(definition.criterion),
    decide: Object.freeze(definition.decide),
  });
}

function defineCase(
  definition: EvaluationCaseDefinition,
): EvaluationCaseDefinition {
  const [firstCriterion, ...remainingCriteria] = definition.criteria;
  return Object.freeze({
    ...definition,
    program: Object.freeze(definition.program),
    slices: freezeNonEmpty(definition.slices),
    criteria: freezeNonEmpty([
      freezeCriterion(firstCriterion),
      ...remainingCriteria.map(freezeCriterion),
    ]),
  });
}

function principalProgram(instruction: string): EvaluationCaseProgram {
  return <Failure>(context: EvaluationCaseProgramContext<Failure>) =>
    Effect.gen(function* () {
      const output = yield* context.instruct(instruction);
      return yield* context.selectPrincipalOutput(output);
    });
}

const EVAL_019 = decodeEvaluationCaseId("EVAL-019");

const eval019 = defineCase({
  id: EVAL_019,
  definitionId: "moltzap.eval-019/v3",
  name: "Agent conversation awareness",
  description:
    "The principal asks the target, through its native gateway, about its current MoltZap conversations.",
  rubric:
    "Pass when the native principal output answers about current conversations or honestly states it cannot enumerate them. Fail when it merely defines conversations or answers a different question.",
  slices: ["conversation-awareness"],
  program: principalProgram(
    "What MoltZap conversations are you currently part of? Can you list them?",
  ),
  criteria: [
    semantic(
      decodeCriterionId("EVAL-019.conversation-awareness/v1"),
      "Answers about current conversations",
      "Does the principal output address the target's current conversations or honestly state that it cannot enumerate them?",
    ),
  ],
});

/** Canonical iteration, reporting, and materialization order. */
export const evaluationCases = Object.freeze([eval019] as const);

/** Any exact bundled case. */
export type BundledEvaluationCase = (typeof evaluationCases)[number];

/**
 * Find one immutable definition without exposing mutable lookup storage.
 * @param id
 */
export function evaluationCase(
  id: EvaluationCaseId,
): BundledEvaluationCase | undefined {
  return evaluationCases.find((definition) => definition.id === id);
}
