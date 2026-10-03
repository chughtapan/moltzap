/** @file The loopback MCP edge the daemon service composes. */

/** Credential roles for tunneled runtime and owner requests. */
export { credentialMatches, type HarnessMcpCredentials } from "./auth.js";
/** The loopback Streamable HTTP listener. */
export { acquireHarnessMcpHttpServer } from "./http.js";
/** Owner-tool results the service returns through the catalog. */
export type {
  ManagementReadConversationResult,
  ManagementRegisterResult,
  ManagementSearchAgentsResult,
  ManagementSearchConversationsRequest,
  ManagementSearchConversationsResult,
  ManagementStatusResult,
} from "./owner-tools.js";
/** Closed wire schemas for inbox reads, sends, and Events delivery. */
export {
  decodeHarnessSendErrorData,
  decodeHarnessSendOutcome,
  decodeHarnessSendRequest,
  eventIdSchema,
  type EventStore,
  type HarnessMessageReadyEvent,
  type HarnessReadInboxRequest,
  type HarnessReadInboxResult,
  type HarnessReadSendRequest,
  type HarnessReadSendResult,
  type HarnessSendOutcome,
  type HarnessSendRequest,
} from "./schemas.js";
/** The tool catalog that projects Harness operations and owner tools. */
export {
  type HarnessMcpEventHandler,
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";
