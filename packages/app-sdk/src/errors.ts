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
 * **Triggered by:** the SDK's option-parsing code when neither `appId`
 * nor `manifest` is supplied to {@link MoltZapApp}; subclasses cover
 * every other failure mode.
 *
 * **Common causes:** misuse of the SDK options object; programming
 * defects.
 *
 * **Recovery:** discriminate on `err.code` (or use the typed subclass)
 * and surface the misuse to the operator. There is no automatic
 * recovery — fix the call site.
 *
 * @example
 * ```ts
 * import { AppError } from "@moltzap/app-sdk";
 *
 * try {
 *   throw new AppError("INVALID_CONFIG", "appId or manifest is required");
 * } catch (err) {
 *   if (err instanceof AppError) {
 *     console.error(`[${err.code}] ${err.message}`);
 *   }
 * }
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
 * **Triggered by:** `auth/connect` returning an RPC error; WebSocket
 * connect failing before the handshake completes; protocol-version
 * negotiation failing.
 *
 * **Common causes:** wrong or revoked `agentKey`; server unreachable
 * (DNS, firewall); protocol-version skew between client and server;
 * server rejecting the connection at the upgrade.
 *
 * **Recovery:** authenticate fatal — re-issue the agent key, fix the
 * server URL, or upgrade the SDK to match the server's protocol
 * version. Retrying with the same credentials will not help.
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
 *       Effect.sync(() => {
 *         console.error("auth failed:", err.message);
 *         process.exit(1); // re-issue the agent key, then retry
 *       }),
 *     ),
 *   ),
 * );
 * ```
 */
export class AuthError extends AppError {
  /** Tag used for `Effect.catchTag` discrimination. */
  readonly _tag = "AuthError" as const;

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
 * **Triggered by:** `apps/create` returning an RPC error; session
 * recovery on reconnect failing; per-session admission timing out
 * before any agent is admitted.
 *
 * **Common causes:** invited agents not reachable (no `ownerUserId`,
 * ContactService rejection); admin permission timeouts; manifest
 * `limits.maxParticipants` exceeded; missing skill attestation.
 *
 * **Recovery:** retry creation with a different invitee set, or fix
 * the upstream issue (claim the agent's owner, grant the missing
 * permission, etc.). Retrying with the same inputs that just failed
 * will fail again.
 *
 * @example
 * ```ts
 * try {
 *   await app.createSessionAsync(["agent-a", "agent-b"]);
 * } catch (err) {
 *   if (err instanceof SessionError) {
 *     console.error(`[${err.code}] ${err.message}`);
 *     // Retry with only the reachable invitee:
 *     await app.createSessionAsync(["agent-a"]);
 *   }
 * }
 * ```
 */
export class SessionError extends AppError {
  /** Tag used for `Effect.catchTag` discrimination. */
  readonly _tag = "SessionError" as const;

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
 * **Triggered by:** `app/sessionClosed` event delivery from the
 * server; post-reconnect `apps/getSession` reporting `state: "closed"`
 * or `"failed"`.
 *
 * **Common causes:** initiator agent called `apps/closeSession`;
 * session reached `limits.timeout_ms`; AppHost terminated the session
 * because all participants disconnected; an `on_close` lifecycle hook
 * failure cascaded.
 *
 * **Recovery:** drop session-scoped state, then optionally call
 * `app.createSession(...)` to start a fresh session. The closed
 * session id will not return — local references must go.
 *
 * @example
 * ```ts
 * app.onError((err) => {
 *   if (err instanceof SessionClosedError) {
 *     // session is gone; clean up local state
 *     myCache.delete(currentSessionId);
 *     // Optionally start a fresh session:
 *     //   void app.createSessionAsync(invitedAgentIds);
 *   }
 * });
 * ```
 */
export class SessionClosedError extends AppError {
  /** Tag used for `Effect.catchTag` discrimination. */
  readonly _tag = "SessionClosedError" as const;

  constructor(message: string, cause?: Error) {
    super("SESSION_CLOSED", message, cause);
    this.name = "SessionClosedError";
  }
}

/**
 * The server rejected the manifest at `apps/register`.
 *
 * **Triggered by:** `apps/register` returning an RPC error during
 * {@link MoltZapApp.start}.
 *
 * **Common causes:** unknown permission resource; invalid or missing
 * conversation `key`; a manifest field that fails the schema check
 * (e.g., a removed field like `hooks.<name>.webhook` or `secret` —
 * Phase 1 deletion); duplicate `appId` registered against another key.
 *
 * **Recovery:** fix the manifest and restart. The schema rejects the
 * same input on retry, so blind retries do not help. Compare your
 * manifest against `docs/guides/building-apps.mdx` and
 * `docs/migration/webhook-to-rpc.mdx` (repo root) if you are porting
 * from the webhook era.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { ManifestRegistrationError } from "@moltzap/app-sdk";
 *
 * await Effect.runPromise(
 *   app.start().pipe(
 *     Effect.catchTag("ManifestRegistrationError", (err) => {
 *       console.error("manifest rejected:", err.message);
 *       // Likely a stale manifest field. Fix the manifest and re-deploy.
 *       return Effect.fail(err);
 *     }),
 *   ),
 * );
 * ```
 */
export class ManifestRegistrationError extends AppError {
  /** Tag used for `Effect.catchTag` discrimination. */
  readonly _tag = "ManifestRegistrationError" as const;

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
 * **Triggered by:** {@link MoltZapApp.send} resolving the conversation
 * id from the key and finding no entry in any active session's
 * `conversations` map.
 *
 * **Common causes:** typo in the key; the session has not finished
 * admission yet (no `app/sessionReady` received); the manifest's
 * `conversations[]` does not declare a conversation with that key.
 *
 * **Recovery:** route to a known-good key (the manifest's `default`
 * is always present), or wait for `onSessionReady` before sending.
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
  /** Tag used for `Effect.catchTag` discrimination. */
  readonly _tag = "ConversationKeyError" as const;

  constructor(key: string) {
    super("UNKNOWN_CONVERSATION_KEY", `Unknown conversation key: "${key}"`);
    this.name = "ConversationKeyError";
  }
}

/**
 * `messages/send` failed at the transport or server-validation layer.
 * The {@link cause} retains the underlying RPC error tag.
 *
 * **Triggered by:** {@link MoltZapApp.send}, {@link MoltZapApp.sendTo},
 * or {@link MoltZapApp.reply} when the underlying `messages/send` RPC
 * returns an error or the transport drops mid-call.
 *
 * **Common causes:** the conversation no longer exists or you are not
 * a participant; rate-limited by the server; transport-level error
 * (WS closed, RPC timeout); a `before_dispatch` hook denied the
 * dispatch (the deny `reason` surfaces in `err.message`).
 *
 * **Recovery:** if `cause` is a transient RPC timeout, retry with
 * backoff; if it is a `deny` verdict from a hook, fix the message or
 * route differently — retrying the same payload will deny again.
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
  /** Tag used for `Effect.catchTag` discrimination. */
  readonly _tag = "SendError" as const;

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
 * **Triggered by:** the SDK's hook-handler wrapper when a user
 * `onBeforeDispatch` / `onBeforeMessageDelivery` / `onSessionActive` /
 * `onJoin` / `onClose` callback returns a failed Effect or throws.
 *
 * **Common causes:** uncaught defect inside the handler; an external
 * dependency the handler called (DB, HTTP, RPC) failed; the handler
 * returned `Effect.fail(...)` without catching.
 *
 * **Recovery:** none at the SDK level — the AppHost has already
 * synthesized a fail-closed verdict. Tooling consumes this class via
 * the SDK logger or test fixtures to assert fail-closed behavior. To
 * choose a custom `reason` instead of `"app_handler_error"`, catch
 * inside your handler and return a typed verdict.
 *
 * @example
 * ```ts
 * // Tooling / test fixture observing fail-closed semantics:
 * import { AppHandlerError } from "@moltzap/app-sdk";
 *
 * const wrapped = new AppHandlerError(
 *   "apps/onBeforeDispatch",
 *   "user handler threw",
 *   new Error("rate-limit lookup timed out"),
 * );
 * console.error(wrapped.code, wrapped.method, wrapped.message);
 * // → APP_HANDLER_ERROR apps/onBeforeDispatch [apps/onBeforeDispatch] user handler threw
 * ```
 */
export class AppHandlerError extends AppError {
  /** Tag used for `Effect.catchTag` discrimination. */
  readonly _tag = "AppHandlerError" as const;
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
 * **Triggered by:** the AppHost's `Effect.timeout(manifestMs)`
 * elapsing before the handler returns a verdict for an admission
 * hook (`apps/onBeforeDispatch`, `apps/onBeforeMessageDelivery`).
 *
 * **Common causes:** handler did slow I/O (DB, HTTP, LLM call) and
 * exceeded `manifest.hooks.<name>.timeout_ms`; handler is awaiting
 * external input that never arrived; misconfigured (too tight)
 * timeout for a legitimately slow workload.
 *
 * **Recovery:** raise `manifest.hooks.<name>.timeout_ms` (the schema is
 * `Type.Integer({ default: 5000, minimum: 1 })` — no upper bound since
 * B.4 follow-up #324); cache the slow lookup; or short-circuit fast
 * inside the handler when the answer is already known. The AppHost has
 * already issued the fail-closed verdict; this class is for observability.
 *
 * @example
 * ```ts
 * // Test fixture asserting fail-closed semantics on timeout:
 * import { AdmissionTimeoutError } from "@moltzap/app-sdk";
 *
 * const err = new AdmissionTimeoutError("apps/onBeforeDispatch", 30_000);
 * expect(err.code).toBe("ADMISSION_TIMEOUT");
 * expect(err.method).toBe("apps/onBeforeDispatch");
 * expect(err.timeoutMs).toBe(30_000);
 * ```
 */
export class AdmissionTimeoutError extends AppError {
  /** Tag used for `Effect.catchTag` discrimination. */
  readonly _tag = "AdmissionTimeoutError" as const;
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
 * **Triggered by:** the server-side connection scope finalizer
 * failing every pending s2c `Deferred` with `AppDisconnected` when
 * the app's WebSocket closes mid-admission.
 *
 * **Common causes:** app crashed; app deployed/restarted while a hook
 * was in flight; network partition; load-balancer health-check killed
 * the WS; client called `app.stop()` while a hook was in flight.
 *
 * **Recovery:** the AppHost has already applied fail-closed verdicts
 * for any pending admissions on the dropped connection; nothing to
 * recover. The reconnect loop in `MoltZapWsClient` re-establishes the
 * connection and re-registers the manifest; new hooks fire normally
 * after that. To make admission less brittle to restart, deploy
 * with rolling restart and a graceful drain.
 *
 * @example
 * ```ts
 * // Tooling instrumentation asserting fail-closed semantics on
 * // mid-admission disconnect:
 * import { AppDisconnected } from "@moltzap/app-sdk";
 *
 * const err = new AppDisconnected("apps/onBeforeMessageDelivery");
 * expect(err.code).toBe("APP_DISCONNECTED");
 * expect(err.method).toBe("apps/onBeforeMessageDelivery");
 * ```
 */
export class AppDisconnected extends AppError {
  /** Tag used for `Effect.catchTag` discrimination. */
  readonly _tag = "AppDisconnected" as const;
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
 * **Triggered by:** {@link MoltZapApp.attachConversation} resolving
 * the c2s `apps/attachConversation` RPC into a typed failure.
 *
 * **Common causes (per code):**
 *
 * - `SessionNotFound`: caller passed a stale session id, or the
 *   session has already closed.
 *
 * - `ConversationNotFound`: caller passed a stale conversation id, or
 *   the conversation was archived.
 *
 * - `NotAuthorized`: the apiKey on the WS connection does not own the
 *   session — wrong app or tenant.
 *
 * - `AttachFailed`: transport-level error (RPC timeout, server 5xx).
 *
 * **Recovery:** use `Effect.catchTag("AttachError", ...)` (this class
 * sets `_tag = "AttachError"`) and branch on `err.code`. For
 * `SessionNotFound` / `ConversationNotFound`, drop local references.
 * For `NotAuthorized`, fix the apiKey or session id wiring. For
 * `AttachFailed`, retry with backoff.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import type { AttachError } from "@moltzap/app-sdk";
 *
 * await Effect.runPromise(
 *   app.attachConversation(sessionId, conversationId).pipe(
 *     Effect.catchTag("AttachError", (err: AttachError) => {
 *       switch (err.code) {
 *         case "SessionNotFound":
 *         case "ConversationNotFound":
 *           return Effect.sync(() => console.warn(`gone: ${err.code}`));
 *         case "AlreadyAttached":
 *           return Effect.sync(() =>
 *             console.warn("convId already bound to another session"),
 *           );
 *         case "NotAuthorized":
 *           return Effect.fail(err); // programming error; surface it
 *         case "AttachFailed":
 *           return Effect.sync(() => console.warn("retry later"));
 *       }
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

export class ObservabilityError extends AppError {
  readonly _tag = "ObservabilityError" as const;

  constructor(message: string, cause?: Error) {
    super("OBSERVABILITY_ERROR", message, cause);
    this.name = "ObservabilityError";
  }
}

export class ConfigValidationError extends AppError {
  readonly _tag = "ConfigValidationError" as const;
  readonly field: string;
  readonly value: unknown;

  constructor(field: string, value: unknown, message: string, cause?: Error) {
    super("CONFIG_VALIDATION_ERROR", message, cause);
    this.name = "ConfigValidationError";
    this.field = field;
    this.value = value;
  }
}

export class SessionNotFoundError extends AppError {
  readonly _tag = "SessionNotFoundError" as const;
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      "SESSION_NOT_FOUND",
      `No replay bundle recorded for session ${sessionId}`,
    );
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}
