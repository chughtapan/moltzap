/**
 * @file R-channel capability tokens for privileged service methods.
 * See `README.md` in this directory for the pattern overview and
 * `packages/server/src/app/capability-providers.ts` (file-level
 * JSDoc) for the migration recipe.
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

// Composite — Architect Decision C (Phase 3, r3)
export {
  ConversationCreateAuthorization,
  type ConversationCreateAuthorizationValue,
  type ObtainConversationCreateAuthorizationInput,
  obtainConversationCreateAuthorization,
} from "./conversation-create-authorization.js";

// Composite — Architect Decision D (Phase 3, r3)
export {
  AddParticipantPermission,
  type AddParticipantPermissionValue,
  type ObtainAddParticipantPermissionInput,
  obtainAddParticipantPermission,
} from "./add-participant-permission.js";

// Runtime equality guards
export {
  assertTmAuthorityMatchesTask,
  assertTaskReadAccessMatchesTask,
  assertConversationInTaskMatches,
} from "./assert-capability-matches-task.js";
