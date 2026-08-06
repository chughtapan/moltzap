/** @file Shared schema-backed identities and report vocabulary for evaluations. */
// safer-arch-ignore shared-kernel-cohesion: identity and vocabulary schemas are a foundation every evaluation module binds to, so disjoint consumer sets are expected rather than a sign of an accidental grab-bag.

import { Schema } from "effect";

/** Schema for the stable identity of one bundled behavioral evaluation. */
export const evaluationCaseId = Schema.String.pipe(
  Schema.pattern(/^EVAL-\d{3}$/u),
  Schema.brand("EvaluationCaseId"),
);
/** Stable identity of one bundled behavioral evaluation. */
export type EvaluationCaseId = typeof evaluationCaseId.Type;

/** Schema for one ledger envelope admitted as evaluation evidence. */
export const evaluationEvidenceId = Schema.NonEmptyString.pipe(
  Schema.brand("EvaluationEvidenceId"),
);
/** Ledger envelope identity admitted as evaluation evidence. */
export type EvaluationEvidenceId = typeof evaluationEvidenceId.Type;

const CONDITION_ID = /^[a-z0-9][a-z0-9._-]*\/v[1-9]\d*$/u;

/** Schema for one runtime condition and its configuration contract. */
export const conditionId = Schema.NonEmptyString.pipe(
  Schema.pattern(CONDITION_ID),
  Schema.brand("ConditionId"),
);
/** Stable identity of one runtime condition and its configuration contract. */
export type ConditionId = typeof conditionId.Type;

/**
 * The complete set of conditions the bundled matrix compares. Consumers that
 * must act per condition are total over this union, so introducing a third
 * runtime is a compile error rather than a fallback that picks an existing one.
 */
const evaluationConditionId = Schema.Literal("openclaw/v2", "nanoclaw/v2").pipe(
  Schema.pattern(CONDITION_ID),
  Schema.brand("ConditionId"),
);
/** One condition the bundled matrix compares, as its own literal. */
export type EvaluationConditionId = typeof evaluationConditionId.Type;
/** The unbranded spelling of one bundled matrix condition. */
export type EvaluationConditionName = typeof evaluationConditionId.Encoded;

/** Schema for one versioned behavioral criterion. */
export const criterionId = Schema.NonEmptyString.pipe(
  Schema.pattern(/^EVAL-\d{3}\.[a-z0-9][a-z0-9-]*\/v[1-9]\d*$/u),
  Schema.brand("CriterionId"),
);
/** Stable identity of one versioned behavioral criterion. */
export type CriterionId = typeof criterionId.Type;

/** Schema for one semantic-judge policy identity. */
export const judgePolicyId = Schema.NonEmptyString.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]*\/v[1-9]\d*$/u),
  Schema.brand("JudgePolicyId"),
);
/** Stable identity of one semantic-judge policy. */
export type JudgePolicyId = typeof judgePolicyId.Type;

/** Schema for one versioned judge-calibration fixture identity. */
export const calibrationFixtureId = Schema.NonEmptyString.pipe(
  Schema.pattern(/^calibration-[a-z0-9][a-z0-9-]*\/v[1-9]\d*$/u),
  Schema.brand("CalibrationFixtureId"),
);

/** Schema for whole counts and millisecond deadlines, which are never zero. */
export const positiveInteger = Schema.Int.pipe(Schema.positive());

/** Schema for the complete per-criterion verdict vocabulary. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- judge and report schemas compose this complete verdict vocabulary.
export const criterionVerdict = Schema.Literal("passed", "failed", "undecided");
/** Complete per-criterion verdict vocabulary. */
export type CriterionVerdict = typeof criterionVerdict.Type;

/** Serializable criterion metadata sent unchanged to the semantic judge. */
export class EvaluationCriterion extends Schema.Class<EvaluationCriterion>(
  "EvaluationCriterion",
)({
  id: criterionId,
  name: Schema.NonEmptyString,
  question: Schema.NonEmptyString,
}) {}

/** A deterministic check conclusively settled one criterion. */
export class CriterionDecided extends Schema.TaggedClass<CriterionDecided>()(
  "CriterionDecided",
  {
    criterionId: criterionId,
    verdict: Schema.Literal("passed", "failed"),
    detail: Schema.NonEmptyString,
    citations: Schema.NonEmptyArray(evaluationEvidenceId),
  },
) {}

/** Deterministic code preserved a semantic question for the judge. */
export class NeedsJudge extends Schema.TaggedClass<NeedsJudge>()("NeedsJudge", {
  criterionId: criterionId,
  question: Schema.NonEmptyString,
}) {}

/** Schema for the complete bundled report-slice vocabulary. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- report and Phoenix schemas compose this complete slice vocabulary.
export const evaluationSlice = Schema.Literal(
  "baseline",
  "group-behavior",
  "disclosure",
  "injection-resistance",
  "conversation-awareness",
  "negotiation",
  "privacy",
  "context-retention",
  "identity-awareness",
);
/** Complete bundled report-slice vocabulary. */
export type EvaluationSlice = typeof evaluationSlice.Type;

/** Decode trusted code constants through the canonical case-id schema. */
export const decodeEvaluationCaseId = Schema.decodeSync(evaluationCaseId);
/** Decode ledger envelopes through the canonical evidence-id schema. */
export const decodeEvaluationEvidenceId =
  Schema.decodeSync(evaluationEvidenceId);
/** Decode trusted code constants through the canonical condition-id schema. */
export const decodeConditionId = Schema.decodeSync(conditionId);
/** Decode trusted code constants through the bundled matrix-condition schema. */
export const decodeEvaluationConditionId = Schema.decodeSync(
  evaluationConditionId,
);
/** Decode trusted code constants through the canonical criterion-id schema. */
export const decodeCriterionId = Schema.decodeSync(criterionId);
/** Decode trusted code constants through the canonical judge-policy schema. */
export const decodeJudgePolicyId = Schema.decodeSync(judgePolicyId);
