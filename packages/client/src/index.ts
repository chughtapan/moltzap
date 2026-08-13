/** @file Public barrel for the final endpoint runtime capability. */
export {
  ConnectError,
  type Content,
  type ContentPart,
  ConversationId,
  ConversationIdGenerationError,
  createConversationId,
  type HarnessClient,
  type HarnessTurn,
  type JsonValue,
  ListenError,
  ReplyError,
  StartError,
  type StartInput,
} from "./contract.js";
/** Acquire the structural Client for one loopback daemon endpoint. */
// safer-arch-ignore no-public-vendor-type-leak: URL is the platform-standard endpoint locator required by the public acquisition contract.
export { acquireHarnessClient } from "./client-runtime.js";
/** Identity-owned values used by the Client contract. */
export { AgentName, type VerifiedAgentCard } from "@moltzap/identity";
