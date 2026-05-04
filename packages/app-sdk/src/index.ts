// Main class
export { MoltZapApp } from "./app.js";
export type { MoltZapAppOptions } from "./app.js";

// Session handle
export { AppSessionHandle } from "./session.js";

// Heartbeat
export { HeartbeatManager } from "./heartbeat.js";

// Errors
export {
  InvalidConfigError,
  DuplicateHookHandlerError,
  UserHandlerError,
  AuthError,
  SessionError,
  SessionClosedError,
  ManifestRegistrationError,
  ConversationKeyError,
  SendError,
  AppHandlerError,
  AdmissionTimeoutError,
  AppDisconnected,
  AttachSessionNotFoundError,
  AttachConversationNotFoundError,
  AttachNotAuthorizedError,
  AttachAlreadyAttachedError,
  AttachFailedError,
} from "./errors.js";
export type { AppError, AttachError } from "./errors.js";

// Re-export common protocol types for convenience
export type {
  AppManifest,
  AppManifestConversation,
  AppPermission,
  AppSession,
  Part,
  TextPart,
  ImagePart,
  FilePart,
  Message,
  NotificationFrame,
  // Admission + lifecycle handler context types (Phase 1.4 / B.5).
  // Surfaced here so app developers can import them directly from
  // `@moltzap/app-sdk` without reaching into the protocol package.
  BeforeDispatchContext,
  BeforeMessageDeliveryContext,
  OnSessionActiveContext,
  OnJoinContext,
  OnCloseContext,
  HookResult,
  DispatchAdmissionResult,
} from "@moltzap/protocol";

// Re-export client types
export type { WsClientLogger } from "@moltzap/client";
