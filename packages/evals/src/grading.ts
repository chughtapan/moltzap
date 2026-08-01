/** @file Evidence-ID grading and semantic judging for behavioral evaluations. */

/** Re-exports the public API from `./transcript.js`. */
export {
  EvaluationTarget,
  EvaluationTranscript,
  GatewayTranscriptItem,
  GradingRefused,
  PeerTimeoutTranscriptItem,
  SocialTranscriptItem,
  transcriptFromLedger,
} from "./transcript.js";

/** Re-exports the public API from `./judge.js`. */
export {
  JudgeCriterionResult,
  JudgeEvidenceMismatch,
  JudgeInvalidOutput,
  JudgeResult,
  JudgeUnavailable,
  SemanticJudge,
  judgeError,
  makeSemanticJudgeTestLayer,
  validateJudgeResult,
} from "./judge.js";

/** Re-exports the public API from `./assessment.js`. */
export {
  CodeAssessment,
  GradeCompleted,
  GradeJudgeFailed,
  GradeReport,
  SemanticAssessment,
  gradeTranscript,
  validateAssessmentEvidence,
  verdictOf,
  type CriterionAssessment,
} from "./assessment.js";

/** Re-exports the public API from `./calibration.js`. */
export {
  JudgeCalibrationPassed,
  runSemanticJudgeCalibration,
  semanticJudgeCalibrationFixtures,
} from "./calibration.js";

/** Re-exports the public API from `./judge-openai.js`. */
export {
  OPENAI_SEMANTIC_JUDGE_MODEL,
  OPENAI_SEMANTIC_JUDGE_TIMEOUT_MILLIS,
  SemanticJudgeOpenAi,
  judgePrompt,
} from "./judge-openai.js";
