/**
 * @file R-channel capability tokens for privileged service methods.
 *
 * Architect plan #606 / Spec #601. See `README.md` in this directory
 * for the pattern overview; see
 * `packages/server/docs/architecture/10-r-channel-capabilities.md`
 * for the migration recipe + bug-class explainer.
 */

// Tier 1 — authority capabilities
export {
  TmAuthority,
  type TmAuthorityValue,
  obtainTmAuthority,
} from "./tm-authority.js";
export {
  TaskReadAccess,
  type TaskReadAccessValue,
  obtainTaskReadAccess,
} from "./task-read-access.js";
export {
  ConversationParticipantAccess,
  type ConversationParticipantAccessValue,
  obtainConversationParticipantAccess,
} from "./conversation-participant-access.js";

// Tier 2 — relationship + existence proofs
export {
  ConversationInTask,
  type ConversationInTaskValue,
  obtainConversationInTask,
} from "./conversation-in-task.js";
export {
  AgentExists,
  type AgentExistsValue,
  obtainAgentExists,
} from "./agent-exists.js";
export {
  AgentInTaskParticipants,
  type AgentInTaskParticipantsValue,
  obtainAgentInTaskParticipants,
} from "./agent-in-task-participants.js";

// Tier 3 — contact policy (composite)
export {
  ContactPolicyAllowsReach,
  type ContactPolicyAllowsReachValue,
  obtainContactPolicyForCreate,
  obtainContactPolicyForAdd,
} from "./contact-policy-allows-reach.js";

// Tier 4 — state proofs (refine-shape)
export {
  TaskActive,
  type TaskActiveValue,
  refineTaskActive,
} from "./task-active.js";
export {
  ConversationNotArchived,
  type ConversationNotArchivedValue,
  refineConversationNotArchived,
} from "./conversation-not-archived.js";
export {
  ValidReplyTarget,
  type ValidReplyTargetValue,
  NoReplyTarget,
  type NoReplyTargetValue,
  obtainValidReplyTarget,
  noReplyTarget,
} from "./reply-target.js";
export {
  GroupCapacityForCreate,
  type GroupCapacityForCreateValue,
  obtainGroupCapacityForCreate,
} from "./group-capacity-for-create.js";

// Composite — Architect Decision A
export {
  MessageSendPermission,
  type MessageSendPermissionValue,
  type ObtainMessageSendPermissionInput,
  obtainMessageSendPermission,
} from "./message-send-permission.js";

// Runtime equality guards
export {
  assertTmAuthorityMatchesTask,
  assertTaskReadAccessMatchesTask,
  assertConversationInTaskMatches,
} from "./assert-capability-matches-task.js";
