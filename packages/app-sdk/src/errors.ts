/**
 * Base error class for all App SDK errors.
 * Every error includes a machine-readable `code` and optional `cause`.
 */
export class AppError extends Error {
  readonly code: string;
  override readonly cause?: Error;

  constructor(code: string, message: string, cause?: Error) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.cause = cause;
  }
}

export class AuthError extends AppError {
  constructor(message: string, cause?: Error) {
    super("AUTH_FAILED", message, cause);
    this.name = "AuthError";
  }
}

export class SessionError extends AppError {
  constructor(message: string, cause?: Error) {
    super("SESSION_ERROR", message, cause);
    this.name = "SessionError";
  }
}

export class SessionClosedError extends AppError {
  constructor(message: string, cause?: Error) {
    super("SESSION_CLOSED", message, cause);
    this.name = "SessionClosedError";
  }
}

export class ManifestRegistrationError extends AppError {
  constructor(message: string, cause?: Error) {
    super("MANIFEST_REJECTED", message, cause);
    this.name = "ManifestRegistrationError";
  }
}

export class ConversationKeyError extends AppError {
  constructor(key: string) {
    super("UNKNOWN_CONVERSATION_KEY", `Unknown conversation key: "${key}"`);
    this.name = "ConversationKeyError";
  }
}

export class SendError extends AppError {
  constructor(message: string, cause?: Error) {
    super("SEND_FAILED", message, cause);
    this.name = "SendError";
  }
}
