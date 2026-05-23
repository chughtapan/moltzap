/** @file Public exports for `@moltzap/server-core`. */

// Core API
export { createCoreApp } from "./app/server.js";
export type { CoreConfig, CoreApp } from "./app/types.js";

export type { AgentId, UserId, ConversationId } from "./app/types.js";

// AppHost
export { AppHost } from "./app/app-host.js";
export type { ContactService } from "./app/app-host.js";

// Handler registries — for downstream consumers composing their own RPC router.
// Each export is a top-level `RpcMethodRegistry` const whose binding bodies
// pull service Tags via `yield*`. Compose with `Effect.provide(FullLive)` at
// boot to wire the service graph.
export { connectHandlers } from "./task/handlers/connect.handlers.js";
export { agentsLookupHandlers } from "./identity/handlers/agents-lookup.handlers.js";
export { pingHandlers } from "./network/handlers/ping.handlers.js";
export { messageHandlers } from "./task/handlers/messages.handlers.js";
export { presenceHandlers } from "./task/handlers/presence.handlers.js";
export { contactHandlers } from "./task/handlers/contacts.handlers.js";
export { appHandlers } from "./app/handlers/apps.handlers.js";
export { ConnectionTag } from "./app/layers.js";

// Service adapters
export type { SessionValidator } from "./identity/services/session-validator.js";
export { WebhookSessionValidator } from "./identity/services/session-validator.js";
export {
  WebhookClient,
  WebhookHttpError,
  WebhookTimeoutError,
  WebhookNetworkError,
} from "./adapters/webhook.js";
export type { WebhookError } from "./adapters/webhook.js";

// Config
export { loadConfigFromFile, ConfigLoadError } from "./config/loader.js";
export { validateConfig, formatConfigErrors } from "./config/schema.js";
export type { MoltZapConfig, ConfigError } from "./config/schema.js";
export {
  RuntimeConfigSurfaceError,
  loadRuntimeProcessConfig,
} from "./runtime-surface/config.js";
export type {
  LoadRuntimeConfigInput,
  RuntimeConfigPath,
  RuntimeEnvironment,
  RuntimeLogLevel,
  RuntimeLoggingConfig,
  RuntimeTracingConfig,
  RuntimeProcessConfig,
} from "./runtime-surface/config.js";
export {
  RuntimeObservabilityError,
  createRuntimeObservability,
  withRuntimeLogContext,
  withRuntimeTraceSpan,
} from "./runtime-surface/logging.js";
export {
  InMemoryTraceCaptureLive,
  NoopTraceCaptureLive,
  TraceCaptureTag,
} from "./runtime-surface/trace-capture.js";
export type {
  RuntimeRequestId,
  RuntimeSessionId,
  RuntimeAgentId,
  RuntimeFiberId,
  RuntimeSpanName,
  RuntimeLogContext,
  RuntimeTraceSpan,
  RuntimeObservability,
} from "./runtime-surface/logging.js";
export type {
  TraceCapture,
  TraceEvent,
  TraceHookBlockedEvent,
  TraceMessageEvent,
} from "./runtime-surface/trace-capture.js";

// Standalone
export { startServer } from "./standalone.js";

// Services
export { AuthService } from "./identity/services/auth.service.js";
export { ConversationService } from "./task/services/conversation.service.js";
export { MessageService } from "./task/services/message.service.js";
export { ParticipantService } from "./identity/services/participant.service.js";
export { PresenceService } from "./network/services/presence.service.js";
export {
  type PresenceEventSink,
  type PresencePublishInput,
  type PresenceStatus,
  createConnectionFanOutPresenceEventSink,
} from "./network/services/presence-event-sink.js";

// Infrastructure
export {
  InvalidParamsError,
  validateParams,
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
export { ConnectionManager } from "./transport/connection.js";
export { EnvelopeEncryption } from "./crypto/envelope.js";
export { seedInitialKek, rotateKek } from "./crypto/key-rotation.js";
export {
  generateApiKey,
  parseApiKey,
  hashSecret,
  generateClaimToken,
  generateInviteToken,
  isValidApiKeyFormat,
} from "./identity/services/agent-auth.js";
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
  DispatchContext,
  RpcMethodBinding,
  RpcMethodRegistry,
} from "./transport/context.js";
export type { MoltZapConnection } from "./transport/connection.js";
export type { TaskRow, TaskParticipantRow } from "./db/database.js";
export { defineMethod } from "./transport/context.js";
