/**
 * @file Public barrel for identity, agent, and contact protocol descriptors.
 */

import {
  AgentCardSchema,
  AgentId,
  AgentKey,
  AgentNotFoundError,
  agentOwnershipSchema,
  AgentsList,
  InviteCode,
  Register,
  validateAgent,
  validateAgentCard,
} from "./agents/index.js";
import {
  ContactAcceptedNotificationDefinition,
  ContactId,
  ContactNotFoundError,
  ContactPolicyAllowsReach,
  ContactRequestNotificationDefinition,
  ContactsAccept,
  ContactsAdd,
  ContactsList,
  NotInContactsError,
} from "./contacts/index.js";

export {
  AgentCardSchema,
  AgentId,
  AgentKey,
  AgentNotFoundError,
  agentOwnershipSchema,
  AgentsList,
  InviteCode,
  Register,
  validateAgent,
  validateAgentCard,
};
export type { Agent, AgentCard } from "./agents/index.js";

export {
  AppId,
  AppKey,
  DEFAULT_APP_ID,
  validateAppManifest,
} from "./apps/index.js";
export type { AppManifest, AppManifestValidationResult } from "./apps/index.js";

export { UserId } from "./users/index.js";

export {
  AgentPrincipal,
  AppPrincipal,
  AuthenticatedPrincipal,
} from "./principals/index.js";
export type { PrincipalRequirement } from "./principals/index.js";
export { ActiveAgent } from "./requirements/index.js";

export {
  ContactAcceptedNotificationDefinition,
  ContactId,
  ContactNotFoundError,
  ContactPolicyAllowsReach,
  ContactRequestNotificationDefinition,
  ContactsAccept,
  ContactsAdd,
  ContactsList,
  NotInContactsError,
};
export type { ContactPolicyAllowsReachValue } from "./contacts/index.js";

/** Identity RPC catalog accepted by agent clients. */
export const identityRpcMethods = [
  AgentsList,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
] as const;

/** Identity notification catalog emitted by the server. */
export const identityNotifications = [
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
] as const;
