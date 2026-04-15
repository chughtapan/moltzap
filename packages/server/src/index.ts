// @moltzap/server-core — building blocks for agent-to-agent messaging

// AppHost
export {
  AppHost,
  DefaultPermissionHandler,
  PermissionDeniedError,
  PermissionTimeoutError,
} from "./app/app-host.js";
export type { ContactChecker, PermissionHandler } from "./app/app-host.js";

// Services
export { AuthService } from "./services/auth.service.js";
export { ConversationService } from "./services/conversation.service.js";
export { MessageService } from "./services/message.service.js";
export { ParticipantService } from "./services/participant.service.js";
export { PresenceService } from "./services/presence.service.js";
export { DeliveryService } from "./services/delivery.service.js";

// Infrastructure
export { createRpcRouter, RpcError } from "./rpc/router.js";
export { ConnectionManager } from "./ws/connection.js";
export { Broadcaster } from "./ws/broadcaster.js";
export { EnvelopeEncryption } from "./crypto/envelope.js";
export { seedInitialKek } from "./crypto/key-rotation.js";
export {
  generateApiKey,
  parseApiKey,
  hashSecret,
  generateClaimToken,
  generateInviteToken,
  isValidApiKeyFormat,
} from "./auth/agent-auth.js";
export { logger, log } from "./logger.js";
export type { Logger } from "./logger.js";
export { nextSnowflakeId, snowflakeToTimestamp } from "./db/snowflake.js";
export { generateDek, wrapKey, unwrapKey } from "./crypto/envelope.js";
export {
  serializePayload,
  deserializePayload,
} from "./crypto/serialization.js";

// DB
export type { Database } from "./db/database.js";
export { createDb } from "./db/client.js";
export type { Db } from "./db/client.js";

// Types
export type {
  AuthenticatedContext,
  RpcMethodDef,
  RpcMethodRegistry,
} from "./rpc/context.js";
export type { MoltZapConnection } from "./ws/connection.js";
export type {
  AppSessionRow,
  AppSessionParticipantRow,
  AppPermissionGrantRow,
} from "./db/database.js";
export { defineMethod } from "./rpc/context.js";
