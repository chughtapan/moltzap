// Main class
export { MoltZapApp } from "./app.js";
export type { MoltZapAppOptions } from "./app.js";

// Session handle
export { AppSessionHandle } from "./session.js";

// Heartbeat
export { HeartbeatManager } from "./heartbeat.js";

// Errors
export {
  AppError,
  AuthError,
  SessionError,
  SessionClosedError,
  ManifestRegistrationError,
  ConversationKeyError,
  SendError,
} from "./errors.js";

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
  EventFrame,
} from "@moltzap/protocol";
export { EventNames } from "@moltzap/protocol";

// Re-export client types
export type { WsClientLogger } from "@moltzap/client";
