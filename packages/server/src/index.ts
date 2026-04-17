// @moltzap/server-core — building blocks for agent-to-agent messaging

// Core API
export { createCoreApp } from "./app/server.js";
export type { CoreConfig, CoreApp } from "./app/types.js";

// AppHost
export {
  AppHost,
  DefaultPermissionService,
  PermissionDeniedError,
  PermissionTimeoutError,
} from "./app/app-host.js";
export type { ContactService, PermissionService } from "./app/app-host.js";

// Handler factories — for downstream consumers composing their own RPC router
export { createCoreAuthHandlers } from "./app/handlers/auth.handlers.js";
export { createConversationHandlers } from "./app/handlers/conversations.handlers.js";
export { createMessageHandlers } from "./app/handlers/messages.handlers.js";
export { createPresenceHandlers } from "./app/handlers/presence.handlers.js";
export { createAppHandlers } from "./app/handlers/apps.handlers.js";
export { ConnIdTag } from "./app/layers.js";

// Service adapters
export type { UserService } from "./services/user.service.js";
export {
  InProcessUserService,
  WebhookUserService,
} from "./services/user.service.js";
export {
  WebhookClient,
  AsyncWebhookAdapter,
  WebhookError,
} from "./adapters/webhook.js";

// Config
export { loadConfigFromFile, ConfigLoadError } from "./config/loader.js";
export {
  validateConfig,
  formatConfigErrors,
  MoltZapConfigSchema,
} from "./config/schema.js";
export type { MoltZapConfig, ConfigError } from "./config/schema.js";

// Standalone
export { startServer } from "./standalone.js";

// Services
export { AuthService } from "./services/auth.service.js";
export { ConversationService } from "./services/conversation.service.js";
export { MessageService } from "./services/message.service.js";
export { ParticipantService } from "./services/participant.service.js";
export { PresenceService } from "./services/presence.service.js";
export { DeliveryService } from "./services/delivery.service.js";

// Infrastructure
export { createRpcRouter } from "./rpc/router.js";
export {
  RpcFailure,
  InvalidParamsError,
  ForbiddenError,
  validateParams,
  notFound,
  forbidden,
  unauthorized,
  invalidParams,
  conflict,
  internalError,
  blocked,
  rateLimited,
  coalesce,
  drainCoalesceMap,
  type Validator,
} from "./runtime/index.js";
export {
  makeEffectKysely,
  takeFirstOption,
  takeFirstOrElse,
  takeFirstOrFail,
  catchSqlErrorAsDefect,
  sqlErrorToDefect,
  transaction,
  rawQuery,
  type EffectKysely,
} from "./db/effect-kysely-toolkit.js";
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
export { logger } from "./logger.js";
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
