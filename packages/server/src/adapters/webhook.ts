/** Webhook adapters for calling external services over HTTP. */

import {
  Data,
  Deferred,
  Duration,
  Effect,
  HashMap,
  Option,
  Ref,
  Schema,
} from "effect";
import { createHmac } from "node:crypto";
import type { ContactService, PermissionService } from "../app/app-host.js";
import type { Logger } from "../logger.js";

/**
 * HMAC-SHA256-sign a webhook payload and return the `X-MoltZap-Signature`
 * header value (`sha256=<hex>`). Receivers recompute over the exact JSON
 * bytes we send, so callers must pass the same `payload` string they will
 * write to the HTTP body.
 */
export function signWebhookPayload(secret: string, payload: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

// -- Tagged error union -------------------------------------------------------

/**
 * Non-2xx HTTP response from the remote webhook. `status` is the actual
 * wire status; `body` captures up to ~response.text() for log context.
 */
export class WebhookHttpError extends Data.TaggedError("WebhookHttpError")<{
  readonly url: string;
  readonly event: string;
  readonly status: number;
  readonly body: string;
}> {
  get message(): string {
    return `Webhook ${this.event} returned ${this.status}: ${this.body}`;
  }
}

/**
 * Request exceeded its `timeoutMs` budget — fired by `Effect.timeoutFail`.
 * Covers both sync-webhook request/response timeouts and async-adapter
 * callback-wait timeouts; the `event` discriminates.
 */
export class WebhookTimeoutError extends Data.TaggedError(
  "WebhookTimeoutError",
)<{
  readonly url: string;
  readonly event: string;
  readonly timeoutMs: number;
}> {
  get message(): string {
    return `Webhook ${this.event} timed out after ${this.timeoutMs}ms`;
  }
}

/**
 * Transport-level failure surfaced by `fetch` (DNS, connection reset,
 * TLS). `cause` is the original thrown value so log sites can inspect
 * `.code` / `.errno` without re-parsing a string.
 */
export class WebhookNetworkError extends Data.TaggedError(
  "WebhookNetworkError",
)<{
  readonly url: string;
  readonly event: string;
  readonly cause: unknown;
}> {
  get message(): string {
    const detail =
      this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Webhook ${this.event} failed: ${detail}`;
  }
}

/**
 * Emitted when `AsyncWebhookAdapter.shutdown` fires while requests are
 * still awaiting their out-of-band callback. Callers treat this like any
 * other fail-closed webhook error.
 */
export class WebhookDestroyedError extends Data.TaggedError(
  "WebhookDestroyedError",
)<{
  readonly requestId: string;
}> {
  get message(): string {
    return `Webhook adapter destroyed while request ${this.requestId} was pending`;
  }
}

/**
 * Response body did not match the caller-supplied decoder — covers both
 * "body wasn't valid JSON" (caught earlier as `WebhookNetworkError`) and
 * "JSON shape didn't match schema" (this error). Fail-closed handling
 * treats it identically to HTTP/network/timeout failures.
 */
export class WebhookDecodeError extends Data.TaggedError("WebhookDecodeError")<{
  readonly url: string;
  readonly event: string;
  readonly cause: unknown;
}> {
  get message(): string {
    const detail =
      this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Webhook ${this.event} response did not match schema: ${detail}`;
  }
}

/** Union of every tagged error the webhook adapters can emit. */
export type WebhookError =
  | WebhookHttpError
  | WebhookTimeoutError
  | WebhookNetworkError
  | WebhookDestroyedError
  | WebhookDecodeError;

// -- Sync webhook client (Users, Contacts) ------------------------------------

/** Options for a single sync webhook call. */
export interface WebhookCallOpts<T> {
  readonly url: string;
  readonly event: string;
  readonly body: unknown;
  readonly timeoutMs: number;
  /**
   * Decoder for the webhook response. The body is read as text, parsed
   * as JSON (or decoded as `undefined` for empty bodies), then passed
   * through this schema — so callers get a checked value of type `T`
   * instead of an unvalidated cast. Schema-mismatches surface as
   * `WebhookDecodeError` and flow through the same fail-closed path as
   * network / timeout errors.
   */
  readonly schema: Schema.Schema<T, any>;
  /**
   * Extra headers merged on top of `Content-Type` + `X-MoltZap-Event`.
   * Used by app-hook webhooks to attach `X-MoltZap-Signature`. Caller-
   * supplied keys win over the defaults — but `Content-Type` and
   * `X-MoltZap-Event` are MoltZap-controlled, so callers should not
   * override those.
   */
  readonly headers?: Record<string, string>;
  /**
   * Pre-serialized JSON body. When provided, `body` is ignored. Used by
   * app-hook webhooks that compute an HMAC signature over the exact
   * bytes that go on the wire — re-serializing here would drift.
   */
  readonly bodyJson?: string;
}

type WebhookCallError =
  | WebhookHttpError
  | WebhookTimeoutError
  | WebhookNetworkError
  | WebhookDecodeError;

/**
 * Best-effort read of a Response body. An unreadable body is logged
 * context, not a failure signal, so we coerce any error to an empty
 * string rather than propagating it.
 */
function readResponseText(response: Response): Effect.Effect<string, never> {
  return Effect.tryPromise({
    try: () => response.text(),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => ""));
}

/**
 * Sync webhook client: POST a payload, receive a parsed JSON response.
 * All failures land in the typed error channel — fetch is driven through
 * `Effect.tryPromise({ try: (signal) => fetch(url, { signal }) })` so
 * fiber interrupt aborts the HTTP socket, and concurrency is bounded by
 * an `Effect.Semaphore` whose permit is returned on interrupt.
 */
export class WebhookClient {
  private readonly permits: Effect.Semaphore;

  constructor(concurrency = 10) {
    // `Effect.makeSemaphore` is pure, so `runSync` in the constructor
    // is safe and keeps the `new WebhookClient()` construction surface
    // unchanged for call sites.
    this.permits = Effect.runSync(Effect.makeSemaphore(concurrency));
  }

  call<T>(opts: WebhookCallOpts<T>): Effect.Effect<T, WebhookCallError> {
    const { url, event, timeoutMs, schema } = opts;
    const body = opts.bodyJson ?? JSON.stringify(opts.body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-MoltZap-Event": event,
      ...opts.headers,
    };

    const doFetch = Effect.tryPromise({
      try: (signal) => fetch(url, { method: "POST", headers, body, signal }),
      catch: (err) => new WebhookNetworkError({ url, event, cause: err }),
    });

    // Parse body → unknown. Empty body (fire-and-forget hooks) decodes as
    // `undefined`; the caller's `schema` accepts or rejects that in the
    // next stage, so no separate null-payload path is needed here.
    const parseResponse = (
      response: Response,
    ): Effect.Effect<unknown, WebhookHttpError | WebhookNetworkError> =>
      readResponseText(response).pipe(
        Effect.flatMap(
          (
            text,
          ): Effect.Effect<unknown, WebhookHttpError | WebhookNetworkError> => {
            if (!response.ok) {
              return Effect.fail(
                new WebhookHttpError({
                  url,
                  event,
                  status: response.status,
                  body: text,
                }),
              );
            }
            if (text.length === 0) return Effect.succeed(undefined);
            return Effect.try({
              try: () => JSON.parse(text) as unknown,
              catch: (err) =>
                new WebhookNetworkError({ url, event, cause: err }),
            });
          },
        ),
      );

    return this.permits.withPermits(1)(
      doFetch.pipe(
        Effect.flatMap(parseResponse),
        Effect.flatMap((parsed) =>
          Schema.decodeUnknown(schema)(parsed).pipe(
            Effect.mapError(
              (cause) => new WebhookDecodeError({ url, event, cause }),
            ),
          ),
        ),
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () => new WebhookTimeoutError({ url, event, timeoutMs }),
        }),
      ),
    );
  }
}

// -- Sync webhook contact service ---------------------------------------------

const ContactsCheckResponse = Schema.Struct({ inContact: Schema.Boolean });

export class WebhookContactService implements ContactService {
  constructor(
    private client: WebhookClient,
    private url: string,
    private timeoutMs: number,
    private webhookLogger: Logger,
  ) {}

  areInContact(
    userIdA: string,
    userIdB: string,
  ): Effect.Effect<boolean, never> {
    return this.client
      .call({
        url: this.url,
        event: "contacts.check",
        body: { userIdA, userIdB },
        timeoutMs: this.timeoutMs,
        schema: ContactsCheckResponse,
      })
      .pipe(
        Effect.map((result) => result.inContact),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            this.webhookLogger.error(
              { err, userIdA, userIdB, url: this.url },
              "Contact check webhook failed, rejecting contact",
            );
            return false;
          }),
        ),
      );
  }
}

// -- Async webhook adapter (Permissions) --------------------------------------

/** How long we remember a resolved request-id so repeat callbacks are idempotent. */
const RESOLVED_TTL_MS = 5 * 60 * 1000;

/** Internal map entry — a Deferred that the HTTP callback route completes. */
type PendingMap = HashMap.HashMap<
  string,
  Deferred.Deferred<string[], WebhookError>
>;

/**
 * Async webhook adapter for the out-of-band permissions flow:
 * POST to the remote, receive `202`, then wait for a later HTTP
 * callback to deliver the access decision.
 *
 * Cleanup invariants (enforced by `Effect.ensuring` / `Effect.onInterrupt`):
 *   - Fiber interrupt removes the pending Deferred from the Ref so no
 *     entry leaks when a caller cancels.
 *   - `Effect.timeoutFail` fires a `WebhookTimeoutError` through the
 *     same cleanup path.
 *   - `shutdown` fails every still-pending Deferred with
 *     `WebhookDestroyedError`.
 */
export class AsyncWebhookAdapter {
  private readonly pending: Ref.Ref<PendingMap>;
  /**
   * `resolved` is a plain Map because it's only touched from the HTTP
   * callback handler (already synchronous at its boundary). Moving it
   * into a Ref would buy no interrupt-safety — the handler either
   * completes its `resolveCallback` call synchronously or it doesn't run
   * at all.
   */
  private readonly resolved = new Map<string, number>();
  private readonly permits: Effect.Semaphore;

  constructor(concurrency = 10) {
    this.pending = Effect.runSync(Ref.make<PendingMap>(HashMap.empty()));
    this.permits = Effect.runSync(Effect.makeSemaphore(concurrency));
  }

  send(opts: {
    readonly url: string;
    readonly requestId: string;
    readonly callbackUrl: string;
    readonly callbackToken: string;
    readonly body: unknown;
    readonly timeoutMs: number;
  }): Effect.Effect<string[], WebhookError> {
    const { url, requestId, timeoutMs } = opts;
    const event = "permissions.check";

    return Effect.gen(this, function* () {
      const deferred = yield* Deferred.make<string[], WebhookError>();

      // Register BEFORE sending the HTTP request: a fast webhook service
      // could fire its callback before fetch() returns.
      yield* Ref.update(this.pending, HashMap.set(requestId, deferred));

      const bodyJson = JSON.stringify({
        request_id: requestId,
        ...(opts.body as object),
      });

      const post = this.permits.withPermits(1)(
        Effect.tryPromise({
          try: (signal) =>
            fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-MoltZap-Event": event,
                "X-MoltZap-Callback-URL": opts.callbackUrl,
                "X-MoltZap-Callback-Token": opts.callbackToken,
              },
              body: bodyJson,
              signal,
            }),
          catch: (err) => new WebhookNetworkError({ url, event, cause: err }),
        }).pipe(
          Effect.flatMap((response) => {
            if (response.status === 202) return Effect.void;
            return readResponseText(response).pipe(
              Effect.flatMap((text) =>
                Effect.fail(
                  new WebhookHttpError({
                    url,
                    event,
                    status: response.status,
                    body: text,
                  }),
                ),
              ),
            );
          }),
        ),
      );

      // Await the callback after the POST succeeds. `ensuring` removes
      // the pending entry on success, failure, AND interrupt — which is
      // what plugs the Bug #3 leak.
      const awaitCallback = Deferred.await(deferred).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () => new WebhookTimeoutError({ url, event, timeoutMs }),
        }),
      );

      return yield* post.pipe(
        Effect.flatMap(() => awaitCallback),
        Effect.ensuring(Ref.update(this.pending, HashMap.remove(requestId))),
      );
    });
  }

  /**
   * Deliver a callback decision to a pending request. Returns `true` if
   * a pending Deferred was completed, or if the request id matches a
   * still-fresh prior resolution (idempotent). Returns `false` for
   * unknown/expired request ids.
   */
  resolveCallback(
    requestId: string,
    access: string[],
  ): Effect.Effect<boolean, never> {
    return Effect.gen(this, function* () {
      // Idempotency: already resolved within TTL.
      const resolvedAt = this.resolved.get(requestId);
      if (resolvedAt !== undefined) {
        if (Date.now() - resolvedAt < RESOLVED_TTL_MS) return true;
        this.resolved.delete(requestId);
        return false;
      }

      // Atomically remove the pending Deferred so no other fiber can
      // also try to complete it. Explicit tuple type keeps TS from
      // widening the two branches to incompatible literal `_tag`s.
      type Taken = Option.Option<Deferred.Deferred<string[], WebhookError>>;
      const taken: Taken = yield* Ref.modify(
        this.pending,
        (map): readonly [Taken, PendingMap] => {
          const existing: Taken = HashMap.get(map, requestId);
          return existing._tag === "None"
            ? [existing, map]
            : [existing, HashMap.remove(map, requestId)];
        },
      );

      if (taken._tag === "None") return false;

      this.resolved.set(requestId, Date.now());
      this.pruneResolved();
      yield* Deferred.succeed(taken.value, access);
      return true;
    });
  }

  /**
   * Fail every pending request with `WebhookDestroyedError`. Called at
   * server shutdown so awaiting fibers unblock rather than hanging on
   * the `Deferred.await` until their timeout.
   */
  readonly shutdown: Effect.Effect<void, never> = Effect.gen(
    this,
    function* () {
      const map = yield* Ref.getAndSet<PendingMap>(
        this.pending,
        HashMap.empty(),
      );
      for (const [requestId, deferred] of HashMap.entries(map)) {
        yield* Deferred.fail(
          deferred,
          new WebhookDestroyedError({ requestId }),
        );
      }
      this.resolved.clear();
    },
  );

  private pruneResolved(): void {
    const cutoff = Date.now() - RESOLVED_TTL_MS;
    for (const [id, ts] of this.resolved) {
      if (ts < cutoff) this.resolved.delete(id);
    }
  }
}

// -- Webhook permission service -----------------------------------------------

export class WebhookPermissionService implements PermissionService {
  constructor(
    private adapter: AsyncWebhookAdapter,
    private webhookUrl: string,
    private callbackBaseUrl: string,
    private callbackToken: string,
    private logger: Logger,
  ) {}

  requestPermission(params: {
    userId: string;
    agentId: string;
    sessionId: string;
    appId: string;
    resource: string;
    access: string[];
    timeoutMs: number;
  }): Effect.Effect<string[], WebhookError> {
    const requestId = crypto.randomUUID();
    const callbackUrl = `${this.callbackBaseUrl}/api/v1/permissions/resolve`;

    return this.adapter
      .send({
        url: this.webhookUrl,
        requestId,
        callbackUrl,
        callbackToken: this.callbackToken,
        body: {
          userId: params.userId,
          agentId: params.agentId,
          sessionId: params.sessionId,
          appId: params.appId,
          resource: params.resource,
          access: params.access,
        },
        timeoutMs: params.timeoutMs,
      })
      .pipe(
        Effect.tapError((err) =>
          Effect.sync(() =>
            this.logger.error(
              { err, requestId, resource: params.resource },
              "Webhook permission request failed",
            ),
          ),
        ),
      );
  }
}
