/** Webhook adapters for calling external services over HTTP. */

import { Data, Duration, Effect, Either, Schema } from "effect";
import { createHmac } from "node:crypto";
import type { ContactService } from "../app/app-host.js";
import type { Logger } from "../logger.js";
import { postJson } from "./fetch-client.js";

const DEFAULT_WEBHOOK_CONCURRENCY = 10;

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
  override get message(): string {
    return `Webhook ${this.event} returned ${this.status}: ${this.body}`;
  }
}

/**
 * Request exceeded its `timeoutMs` budget — fired by `Effect.timeoutFail`.
 */
export class WebhookTimeoutError extends Data.TaggedError(
  "WebhookTimeoutError",
)<{
  readonly url: string;
  readonly event: string;
  readonly timeoutMs: number;
}> {
  override get message(): string {
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
  override get message(): string {
    const detail =
      this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Webhook ${this.event} failed: ${detail}`;
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
  override get message(): string {
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

  constructor(concurrency = DEFAULT_WEBHOOK_CONCURRENCY) {
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
      try: (signal) => postJson(url, { headers, body, signal }),
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
            Effect.either,
            Effect.flatMap(
              Either.match({
                onLeft: (cause) =>
                  Effect.fail(
                    new WebhookDecodeError({
                      url,
                      event,
                      cause,
                    }),
                  ),
                onRight: (decoded) => Effect.succeed(decoded),
              }),
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
