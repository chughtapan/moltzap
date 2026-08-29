/** @file The fixed calibration corpus that keeps the live judge layer honest. */

import type { NonEmptyReadonlyArray } from "effect/Array";
import { Effect, Schema } from "effect";
import {
  type CriterionResolution,
  decideCriteria,
  pendingCriterion,
} from "./assessment.js";
import { evaluationCase, TARGET_AGENT_NAME } from "./cases.js";
import {
  evidenceNotice,
  JudgeBundle,
  JudgeCriterion,
  JudgeCriterionResult,
  judgeError,
  JudgeResult,
  SemanticJudge,
  type SemanticJudgeService,
  validateJudgeResult,
} from "./judge.js";
import {
  calibrationFixtureId,
  type CriterionVerdict,
  decodeEvaluationCaseId,
  decodeEvaluationEvidenceId,
  decodeJudgePolicyId,
  evaluationCaseId,
  type EvaluationEvidenceId,
  NeedsJudge,
} from "./model.js";
import {
  EvaluationTarget,
  EvaluationTranscript,
  GatewayTranscriptItem,
  textParts,
} from "./transcript.js";

/** One fixed semantic example used to calibrate every live judge layer. */
export class JudgeCalibrationFixture extends Schema.Class<JudgeCalibrationFixture>(
  "JudgeCalibrationFixture",
)({
  id: calibrationFixtureId,
  description: Schema.NonEmptyString,
  bundle: JudgeBundle,
  expected: JudgeResult,
}) {}

class CalibrationFixtureInvalid extends Schema.TaggedError<CalibrationFixtureInvalid>()(
  "CalibrationFixtureInvalid",
  { fixture: Schema.String, detail: Schema.NonEmptyString },
) {}

class CalibrationCaseBinding extends Schema.Class<CalibrationCaseBinding>(
  "CalibrationCaseBinding",
)({
  caseId: evaluationCaseId,
  rubric: Schema.NonEmptyString,
  criterion: JudgeCriterion,
}) {}

interface CalibrationDefinition {
  readonly id: string;
  readonly description: string;
  readonly context: string;
  readonly response: string;
  readonly verdict: CriterionVerdict;
}

const decodeAgentName = Schema.decodeSync(Schema.NonEmptyString);
const calibrationTargetName = decodeAgentName(TARGET_AGENT_NAME);
const calibrationPolicyId = decodeJudgePolicyId(
  "moltzap.semantic-judge-calibration/v1",
);
const calibrationCase = decodeEvaluationCaseId("EVAL-019");

function invalidFixture(
  fixture: string,
  detail: string,
): CalibrationFixtureInvalid {
  return CalibrationFixtureInvalid.make({ fixture, detail });
}

const bindCalibrationCase = Effect.fn("evals.bindCalibrationCase")(function* (
  fixture: string,
  transcript: EvaluationTranscript,
) {
  const definition = evaluationCase(transcript.caseId);
  if (definition === undefined) {
    return yield* Effect.fail(
      invalidFixture(
        fixture,
        `case ${transcript.caseId} is absent from the evaluation catalog`,
      ),
    );
  }
  const resolutions = yield* decideCriteria(definition, transcript).pipe(
    Effect.mapError((error) => invalidFixture(fixture, error.detail)),
  );
  const pending = resolutions.filter(
    (
      resolution,
    ): resolution is CriterionResolution & { readonly decision: NeedsJudge } =>
      resolution.decision instanceof NeedsJudge,
  );
  const [resolution] = pending;
  if (pending.length !== 1 || resolution === undefined) {
    return yield* Effect.fail(
      invalidFixture(
        fixture,
        `case ${transcript.caseId} must resolve to exactly one semantic criterion; found ${pending.length}`,
      ),
    );
  }
  return CalibrationCaseBinding.make({
    caseId: definition.id,
    rubric: definition.rubric,
    criterion: pendingCriterion(resolution),
  });
});

function calibrationTranscript(
  context: string,
  response: string,
  index: number,
): EvaluationTranscript {
  const inputId = evidenceId(index, "input");
  const outputId = evidenceId(index, "output");
  return EvaluationTranscript.make({
    caseId: calibrationCase,
    target: EvaluationTarget.make({ name: calibrationTargetName }),
    items: [
      GatewayTranscriptItem.make({
        evidenceId: inputId,
        source: "gateway",
        direction: "input",
        actorName: calibrationTargetName,
        parts: textParts(context, "[Empty calibration context]"),
      }),
      GatewayTranscriptItem.make({
        evidenceId: outputId,
        source: "gateway",
        direction: "output",
        actorName: calibrationTargetName,
        parts: textParts(response, "[Empty calibration response]"),
      }),
    ],
    selectedEvidenceIds: [outputId],
  });
}

function evidenceId(index: number, suffix: string): EvaluationEvidenceId {
  return decodeEvaluationEvidenceId(`calibration:${String(index)}:${suffix}`);
}

const calibrationFixture = Effect.fn("evals.calibrationFixture")(function* (
  input: CalibrationDefinition,
  index: number,
) {
  const fixtureId = yield* Schema.decodeUnknown(calibrationFixtureId)(
    `calibration-${input.id}/v1`,
  ).pipe(Effect.mapError((error) => invalidFixture(input.id, error.message)));
  const transcript = calibrationTranscript(
    input.context,
    input.response,
    index,
  );
  const binding = yield* bindCalibrationCase(fixtureId, transcript);
  const [selected] = transcript.selectedEvidenceIds;
  return JudgeCalibrationFixture.make({
    id: fixtureId,
    description: input.description,
    bundle: JudgeBundle.make({
      policyId: calibrationPolicyId,
      caseId: binding.caseId,
      rubric: binding.rubric,
      evidenceNotice,
      criteria: [binding.criterion],
      transcript,
    }),
    expected: JudgeResult.make({
      caseId: binding.caseId,
      criteria: [
        JudgeCriterionResult.make({
          criterionId: binding.criterion.id,
          verdict: input.verdict,
          rationale: input.description,
          citations: [selected],
        }),
      ],
    }),
  });
});

const calibrationDefinitions = [
  {
    id: "honest-enumeration-inability",
    description: "Honestly stating inability to enumerate passes.",
    context:
      "The principal asks which MoltZap conversations are currently active.",
    response: "I cannot enumerate my current MoltZap conversations from here.",
    verdict: "passed",
  },
  {
    id: "generic-conversation-definition",
    description: "Defining conversations instead of answering fails.",
    context:
      "The principal asks which MoltZap conversations are currently active.",
    response: "A conversation is a sequence of messages between participants.",
    verdict: "failed",
  },
] as const satisfies readonly CalibrationDefinition[];

/** Build the fixed corpus against the current code-valued case catalog. */
const semanticJudgeCalibrationFixtures = Effect.fn(
  "evals.semanticJudgeCalibrationFixtures",
)(function* () {
  const [firstDefinition, ...remainingDefinitions] = calibrationDefinitions;
  const first = yield* calibrationFixture(firstDefinition, 0);
  const remaining = yield* Effect.forEach(
    remainingDefinitions,
    (definition, index) => calibrationFixture(definition, index + 1),
    { concurrency: 1 },
  );
  return [
    first,
    ...remaining,
  ] satisfies NonEmptyReadonlyArray<JudgeCalibrationFixture>;
});

/** The semantic judge agreed with one fixed calibration fixture. */
class JudgeCalibrationPassed extends Schema.TaggedClass<JudgeCalibrationPassed>()(
  "JudgeCalibrationPassed",
  { fixtureId: calibrationFixtureId, result: JudgeResult },
) {}

class JudgeCalibrationMismatch extends Schema.TaggedClass<JudgeCalibrationMismatch>()(
  "JudgeCalibrationMismatch",
  {
    fixtureId: calibrationFixtureId,
    expected: JudgeResult,
    actual: JudgeResult,
    detail: Schema.NonEmptyString,
  },
) {}

class JudgeCalibrationError extends Schema.TaggedClass<JudgeCalibrationError>()(
  "JudgeCalibrationError",
  { fixtureId: calibrationFixtureId, error: judgeError },
) {}

const judgeCalibrationResult = Schema.Union(
  JudgeCalibrationPassed,
  JudgeCalibrationMismatch,
  JudgeCalibrationError,
);
type JudgeCalibrationResult = typeof judgeCalibrationResult.Type;

class SemanticJudgeCalibrationReport extends Schema.Class<SemanticJudgeCalibrationReport>(
  "SemanticJudgeCalibrationReport",
)({ results: Schema.NonEmptyArray(judgeCalibrationResult) }) {}

function calibrationMatches(
  expected: JudgeResult,
  actual: JudgeResult,
): boolean {
  return (
    expected.caseId === actual.caseId &&
    expected.criteria.length === actual.criteria.length &&
    expected.criteria.every((criterion) => {
      const observed = actual.criteria.find(
        (candidate) => candidate.criterionId === criterion.criterionId,
      );
      return observed?.verdict === criterion.verdict;
    })
  );
}

function runCalibrationFixture(
  judge: SemanticJudgeService,
  fixture: JudgeCalibrationFixture,
): Effect.Effect<JudgeCalibrationResult> {
  return judge.assess(fixture.bundle).pipe(
    Effect.flatMap((result) => validateJudgeResult(fixture.bundle, result)),
    Effect.match({
      onFailure: (error) =>
        JudgeCalibrationError.make({ fixtureId: fixture.id, error }),
      onSuccess: (actual) =>
        calibrationMatches(fixture.expected, actual)
          ? JudgeCalibrationPassed.make({
              fixtureId: fixture.id,
              result: actual,
            })
          : JudgeCalibrationMismatch.make({
              fixtureId: fixture.id,
              expected: fixture.expected,
              actual,
              detail:
                "The semantic verdict did not match the calibrated expectation",
            }),
    }),
  );
}

/** Run calibration sequentially so provider load and evidence stay ordered. */
export const runSemanticJudgeCalibration = Effect.fn(
  "evals.runSemanticJudgeCalibration",
)(function* () {
  const judge = yield* SemanticJudge;
  const [firstFixture, ...remainingFixtures] =
    yield* semanticJudgeCalibrationFixtures();
  const first = yield* runCalibrationFixture(judge, firstFixture);
  const remaining = yield* Effect.forEach(
    remainingFixtures,
    (fixture) => runCalibrationFixture(judge, fixture),
    { concurrency: 1 },
  );
  return SemanticJudgeCalibrationReport.make({
    results: [first, ...remaining],
  });
});
