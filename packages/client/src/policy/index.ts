/** @file Service-composition boundary for data-only message assessment. */

/** Fixed-chain construction without daemon activation. */
export { makeMessagePolicyEvaluator } from "./evaluator.js";
/** Explicit provider composition without environment or secret-file lookup. */
export { makeJevDecisionProvider } from "./jev.js";
/** Input validation and closed failures at trusted composition boundaries. */
export {
  MessagePolicyInputError,
  MessagePolicySettings,
  MessagePolicySnapshot,
  PolicyDecisionResponse,
  PolicyProviderFailure,
} from "./values.js";
/** Assessment values contain a private audit, never an admission capability. */
export type {
  MessagePolicyAssessment,
  MessagePolicyEvaluator,
  PolicyDecisionProvider,
  PolicyDecisionRequest,
  PolicyNormGuidance,
  PolicyStage,
  PolicyStageTrace,
} from "./values.js";
