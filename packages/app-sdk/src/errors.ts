import { Data } from "effect";

export class InvalidConfigError extends Data.TaggedError("InvalidConfigError")<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export class DuplicateHookHandlerError extends Data.TaggedError(
  "DuplicateHookHandlerError",
)<{
  readonly method: string;
  readonly message: string;
  readonly cause?: Error;
}> {}

export class UserHandlerError extends Data.TaggedError("UserHandlerError")<{
  readonly message: string;
  readonly cause: Error;
}> {}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export class SessionError extends Data.TaggedError("SessionError")<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export class SessionClosedError extends Data.TaggedError("SessionClosedError")<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export class ManifestRegistrationError extends Data.TaggedError(
  "ManifestRegistrationError",
)<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export class ConversationKeyError extends Data.TaggedError(
  "ConversationKeyError",
)<{
  readonly key: string;
  readonly message: string;
}> {}

export class SendError extends Data.TaggedError("SendError")<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export class AppHandlerError extends Data.TaggedError("AppHandlerError")<{
  readonly method: string;
  readonly message: string;
  readonly cause?: Error;
}> {}

export class AdmissionTimeoutError extends Data.TaggedError(
  "AdmissionTimeoutError",
)<{
  readonly method: string;
  readonly timeoutMs: number;
  readonly message: string;
  readonly cause?: Error;
}> {}

export class AppDisconnected extends Data.TaggedError("AppDisconnected")<{
  readonly method: string;
  readonly message: string;
  readonly cause?: Error;
}> {}

export class AttachSessionNotFoundError extends Data.TaggedError(
  "AttachSessionNotFoundError",
)<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export class AttachConversationNotFoundError extends Data.TaggedError(
  "AttachConversationNotFoundError",
)<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export class AttachNotAuthorizedError extends Data.TaggedError(
  "AttachNotAuthorizedError",
)<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export class AttachAlreadyAttachedError extends Data.TaggedError(
  "AttachAlreadyAttachedError",
)<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export class AttachFailedError extends Data.TaggedError("AttachFailedError")<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export type AttachError =
  | AttachSessionNotFoundError
  | AttachConversationNotFoundError
  | AttachNotAuthorizedError
  | AttachAlreadyAttachedError
  | AttachFailedError;

export type AppError =
  | InvalidConfigError
  | DuplicateHookHandlerError
  | UserHandlerError
  | AuthError
  | SessionError
  | SessionClosedError
  | ManifestRegistrationError
  | ConversationKeyError
  | SendError
  | AppHandlerError
  | AdmissionTimeoutError
  | AppDisconnected
  | AttachError;
