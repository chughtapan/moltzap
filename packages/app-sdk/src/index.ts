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
  AppHandlerError,
  AdmissionTimeoutError,
  AppDisconnected,
  AttachError,
  ConfigValidationError,
  ObservabilityError,
  SessionNotFoundError,
} from "./errors.js";
export type { AttachErrorCode } from "./errors.js";

export {
  MakeFileSystemStore,
  MakeInMemoryStore,
  ReplayStoreIoError,
  ReplayStorePathError,
  TraceparentInvalidError,
  TracerInitError,
  TranscriptWriterError,
  externalParentFromTraceparent,
  formatTraceparent,
  makeReplayRecorder,
  makeTracerLayer,
  makeTranscriptWriter,
  normalizeBufferLimit,
  parseTraceparent,
} from "./observability/index.js";
export type {
  BufferLimit,
  BufferLimitInput,
  HookMethod,
  PositiveInt,
  ReplayBundle,
  ReplayEvent,
  ReplayRecorder,
  ReplayRecorderOptions,
  ReplayStore,
  ReplayStoreRead,
  SessionId,
  SessionSnapshot,
  SnapshotCallback,
  Traceparent,
  TracerInitOptions,
  TranscriptMeta,
  TranscriptWriter,
  VerdictTag,
} from "./observability/index.js";

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
export { EventNames } from "@moltzap/protocol";

// Re-export client types
export type { WsClientLogger } from "@moltzap/client";
