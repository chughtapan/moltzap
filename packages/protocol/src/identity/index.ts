/**
 * @file Public barrel for identity, agent, and contact protocol descriptors.
 */
// safer-arch-ignore no-large-public-surface: This compatibility facade intentionally curates the established identity API while narrower agents, contacts, and apps entrypoints remain available.

import {
  type AgentId,
  agentId,
  type AgentName,
  agentName,
  type AgentKey,
  agentKey,
  type InviteCode,
  inviteCode,
  register,
  agentCardSchema,
  agentsList,
  AgentNotFoundError,
  validateAgent,
  validateAgentCard,
  agentOwnershipSchema,
} from "./agents/index.js";
import {
  type ContactId,
  contactId,
  contactsList,
  contactsAdd,
  contactsAccept,
  contactRequestNotificationDefinition,
  contactAcceptedNotificationDefinition,
  NotInContactsError,
  ContactNotFoundError,
  ContactPolicyAllowsReach,
} from "./contacts/index.js";

/** Re-exports the public API from `current module`. */
export {
  type AgentId,
  agentId,
  type AgentName,
  agentName,
  type AgentKey,
  agentKey,
  type InviteCode,
  inviteCode,
  register,
  agentCardSchema,
  agentsList,
  AgentNotFoundError,
  validateAgent,
  validateAgentCard,
  agentOwnershipSchema,
};
/** Re-exports the public API from `./agents/index.js`. */
export type { Agent, AgentCard } from "./agents/index.js";

/** Re-exports the public API from `./apps/index.js`. */
export {
  type AppId,
  appId,
  DEFAULT_APP_ID,
  type AppKey,
  appKey,
  validateAppManifest,
} from "./apps/index.js";
/** Re-exports the public API from `./apps/index.js`. */
export type { AppManifest, AppManifestValidationResult } from "./apps/index.js";

/** Re-exports the public API from `./users/index.js`. */
export { type UserId, userId } from "./users/index.js";

/** Re-exports the public API from `./principals/index.js`. */
export {
  AgentPrincipal,
  AppPrincipal,
  AuthenticatedPrincipal,
} from "./principals/index.js";
/** Re-exports the public API from `./principals/index.js`. */
export type { PrincipalRequirement } from "./principals/index.js";
/** Re-exports the public API from `./requirements/index.js`. */
export { ActiveAgent } from "./requirements/index.js";

/** Re-exports the public API from `current module`. */
export {
  type ContactId,
  contactId,
  contactsList,
  contactsAdd,
  contactsAccept,
  contactRequestNotificationDefinition,
  contactAcceptedNotificationDefinition,
  NotInContactsError,
  ContactNotFoundError,
  ContactPolicyAllowsReach,
};
/** Re-exports the public API from `./contacts/index.js`. */
export type { ContactPolicyAllowsReachValue } from "./contacts/index.js";

/** Identity RPC catalog accepted by agent clients. */
export const identityRpcMethods = [
  agentsList,
  contactsList,
  contactsAdd,
  contactsAccept,
] as const;

/** Identity notification catalog emitted by the server. */
export const identityNotifications = [
  contactRequestNotificationDefinition,
  contactAcceptedNotificationDefinition,
] as const;
