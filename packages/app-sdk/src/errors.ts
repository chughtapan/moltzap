/**
 * Base error class for all App SDK errors.
 *
 * Every error includes a machine-readable {@link code} so call sites can
 * branch on the failure mode without parsing strings, plus an optional
 * {@link cause} preserving the underlying error chain.
 *
 * Subclass for new error kinds; do not throw raw `AppError` instances
 * unless the code does not warrant a dedicated subclass.
 *
 * @example
 * ```ts
 * import { AppError } from "@moltzap/app-sdk";
 *
 * throw new AppError("INVALID_CONFIG", "appId or manifest is required");
 * ```
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

/**
 * Authentication or initial connect failed: the agent key was rejected,
 * the WebSocket could not open, or the protocol handshake failed.
 *
 * Surfaced from {@link MoltZapApp.start} when `auth/connect` fails.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { MoltZapApp, AuthError } from "@moltzap/app-sdk";
 *
 * const app = new MoltZapApp({ serverUrl, agentKey, appId: "my-app" });
 * await Effect.runPromise(
 *   app.start().pipe(
 *     Effect.catchTag("AuthError", (err: AuthError) =>
 *       Effect.sync(() => console.error("auth failed:", err.message)),
 *     ),
 *   ),
 * );
 * ```
 */
export class AuthError extends AppError {
  constructor(message: string, cause?: Error) {
    super("AUTH_FAILED", message, cause);
    this.name = "AuthError";
  }
}

/**
 * A session-scoped operation failed: create, recover, or operate on a
 * session that the server rejected for non-closed reasons (validation,
 * timeout, etc).
 *
 * Distinct from {@link SessionClosedError} — that fires only when a
 * session has reached terminal `closed` or `failed` state.
 *
 * @example
 * ```ts
 * try {
 *   await app.createSessionAsync(["agent-a", "agent-b"]);
 * } catch (err) {
 *   if (err instanceof SessionError) {
 *     console.error(`[${err.code}] ${err.message}`);
 *   }
 * }
 * ```
 */
export class SessionError extends AppError {
  constructor(message: string, cause?: Error) {
    super("SESSION_ERROR", message, cause);
    this.name = "SessionError";
  }
}

/**
 * The session has terminated and is no longer usable. Emitted via
 * `onError` when the server announces a session closure or when a
 * post-reconnect refresh finds the session in `closed` / `failed`.
 *
 * Handlers should drop session-scoped state and stop emitting messages
 * for the affected session.
 *
 * @example
 * ```ts
 * app.onError((err) => {
 *   if (err instanceof SessionClosedError) {
 *     // session is gone; clean up local state
 *     myCache.delete(currentSessionId);
 *   }
 * });
 * ```
 */
export class SessionClosedError extends AppError {
  constructor(message: string, cause?: Error) {
    super("SESSION_CLOSED", message, cause);
    this.name = "SessionClosedError";
  }
}

/**
 * The server rejected the manifest at `apps/register`. Common causes:
 * unknown permission, invalid conversation key, or a manifest field that
 * fails the schema check.
 *
 * @example
 * ```ts
 * await Effect.runPromise(
 *   app.start().pipe(
 *     Effect.catchTag("ManifestRegistrationError", (err) => {
 *       console.error("manifest rejected:", err.message);
 *       return Effect.fail(err);
 *     }),
 *   ),
 * );
 * ```
 */
export class ManifestRegistrationError extends AppError {
  constructor(message: string, cause?: Error) {
    super("MANIFEST_REJECTED", message, cause);
    this.name = "ManifestRegistrationError";
  }
}

/**
 * `send(conversationKey, parts)` was called with a key that no active
 * session declares. Either the manifest does not declare the key, or no
 * session is currently active.
 *
 * Use {@link MoltZapApp.sendTo} (raw conversation id) when the key
 * indirection is unwanted.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 *
 * await Effect.runPromise(
 *   app.send("typo-key", [{ type: "text", text: "hi" }]).pipe(
 *     Effect.catchTag("UNKNOWN_CONVERSATION_KEY" as never, () =>
 *       app.send("default", [{ type: "text", text: "hi" }]),
 *     ),
 *   ),
 * );
 * ```
 */
export class ConversationKeyError extends AppError {
  constructor(key: string) {
    super("UNKNOWN_CONVERSATION_KEY", `Unknown conversation key: "${key}"`);
    this.name = "ConversationKeyError";
  }
}

/**
 * `messages/send` failed at the transport or server-validation layer.
 * The {@link cause} retains the underlying RPC error tag.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 *
 * await Effect.runPromise(
 *   app.sendTo(convId, [{ type: "text", text: "ping" }]).pipe(
 *     Effect.catchTag("SendError", (err) =>
 *       Effect.sync(() => console.warn("send failed:", err.message)),
 *     ),
 *   ),
 * );
 * ```
 */
export class SendError extends AppError {
  constructor(message: string, cause?: Error) {
    super("SEND_FAILED", message, cause);
    this.name = "SendError";
  }
}

/**
 * A user admission/lifecycle handler failed (defect or typed error). The
 * SDK catches the failure to keep the AppHost RPC contract typed and
 * synthesizes a fail-closed verdict for admission hooks (`deny` /
 * `block: true`) or a no-op for void lifecycle hooks. The wrapped error
 * is logged via the SDK logger and exposed here for observability.
 *
 * Code: `APP_HANDLER_ERROR`.
 *
 * @example
 * ```ts
 * // Internal: SDK wraps user handler failures in AppHandlerError before
 * // logging.  Surface for tooling / tests:
 * const wrapped = new AppHandlerError(
 *   "apps/onBeforeDispatch",
 *   "user handler threw",
 *   originalError,
 * );
 * console.error(wrapped.code, wrapped.message, wrapped.cause);
 * ```
 */
export class AppHandlerError extends AppError {
  /** RPC method whose handler failed (e.g. `apps/onBeforeDispatch`). */
  readonly method: string;

  constructor(method: string, message: string, cause?: Error) {
    super("APP_HANDLER_ERROR", `[${method}] ${message}`, cause);
    this.name = "AppHandlerError";
    this.method = method;
  }
}

/**
 * The server-side AppHost timed out waiting for the app's admission reply
 * and synthesized a fail-closed verdict. The SDK exposes this class so
 * test fixtures and instrumentation can model the timeout case
 * symmetrically with the SDK's own typed errors.
 *
 * Code: `ADMISSION_TIMEOUT`.
 *
 * @example
 * ```ts
 * // In a test fixture asserting fail-closed semantics:
 * const err = new AdmissionTimeoutError(
 *   "apps/onBeforeDispatch",
 *   30_000,
 * );
 * expect(err.code).toBe("ADMISSION_TIMEOUT");
 * expect(err.timeoutMs).toBe(30_000);
 * ```
 */
export class AdmissionTimeoutError extends AppError {
  /** RPC method whose admission timed out. */
  readonly method: string;
  /** Manifest-declared timeout in ms. */
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number, cause?: Error) {
    super(
      "ADMISSION_TIMEOUT",
      `[${method}] admission timed out after ${timeoutMs}ms`,
      cause,
    );
    this.name = "AdmissionTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * SDK-side wrapper for the server's `AppDisconnected` failure. The
 * inbound s2c admission RPC failed because the app's WebSocket dropped
 * before the handler completed. Mirrors the runtime `AppDisconnected`
 * error in `@moltzap/server`'s WS edge.
 *
 * Code: `APP_DISCONNECTED`.
 *
 * @example
 * ```ts
 * // Surfaced by runtime instrumentation when the s2c RPC's pending
 * // Deferred is interrupted by the connection scope's finalizer:
 * const err = new AppDisconnected("apps/onBeforeMessageDelivery");
 * console.error(err.code, err.message);
 * ```
 */
export class AppDisconnected extends AppError {
  /** RPC method whose pending request was dropped. */
  readonly method: string;

  constructor(method: string, cause?: Error) {
    super(
      "APP_DISCONNECTED",
      `[${method}] app disconnected before reply`,
      cause,
    );
    this.name = "AppDisconnected";
    this.method = method;
  }
}

/**
 * `attachConversation` failed. The {@link code} is one of:
 *
 * - `SessionNotFound` — session id does not refer to a session this app owns
 * - `ConversationNotFound` — conversation id does not exist
 * - `NotAuthorized` — the caller is not the session owner
 * - `AlreadyAttached` — the conversation is already attached to a different
 *   session (the 1:1 cross-session invariant on `AppHost.conversationToSession`)
 * - `AttachFailed` — generic transport / server failure (timeout, network)
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 *
 * await Effect.runPromise(
 *   app.attachConversation(sessionId, conversationId).pipe(
 *     Effect.catchTag("AttachError", (err: AttachError) => {
 *       if (err.code === "SessionNotFound" || err.code === "AlreadyAttached") {
 *         return Effect.sync(() => console.warn(err.code));
 *       }
 *       return Effect.fail(err);
 *     }),
 *   ),
 * );
 * ```
 */
export type AttachErrorCode =
  | "SessionNotFound"
  | "ConversationNotFound"
  | "NotAuthorized"
  | "AlreadyAttached"
  | "AttachFailed";

export class AttachError extends AppError {
  override readonly code: AttachErrorCode;
  /** Tag used for `Effect.catchTag` discrimination. */
  readonly _tag = "AttachError" as const;

  constructor(code: AttachErrorCode, message: string, cause?: Error) {
    super(code, message, cause);
    this.name = "AttachError";
    this.code = code;
  }
}
