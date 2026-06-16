/**
 * @file Public barrel for identity, agent, and contact protocol descriptors.
 */

export {
  AgentId,
  AgentKey,
  InviteCode,
  Register,
  AgentCardSchema,
  AgentsList,
  AgentNotFoundError,
  validateAgent,
  validateAgentCard,
  agentOwnershipSchema,
} from "./agents/index.js";
export type { Agent, AgentCard } from "./agents/index.js";

export {
  AppId,
  DEFAULT_APP_ID,
  AppKey,
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
  ContactId,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  NotInContactsError,
  ContactNotFoundError,
  ContactPolicyAllowsReach,
} from "./contacts/index.js";
export type { ContactPolicyAllowsReachValue } from "./contacts/index.js";

import { AgentsList } from "./agents/index.js";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
} from "./contacts/index.js";

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
