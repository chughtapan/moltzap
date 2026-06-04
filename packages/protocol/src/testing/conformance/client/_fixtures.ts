/**
 * Shared fixture helpers for the client-side property bodies.
 *
 * Every client-side property runs the same prologue:
 *   - `yield* ctx.realClientFactory()` — produce a real MoltZap client
 *   - `yield* awaitConnection(ctx.testServer)` — TestServer accepts the WS
 *   - `yield* runAutoHandshakeResponder(connection, ...)` — respond to
 *     network/connect so the real client's `ready` Effect resolves
 *   - `yield* window.awaitHandshakeComplete` — wait for ready to settle
 *
 * Centralizing the prologue + teardown here keeps each property body
 * focused on its discriminating predicate (anti-vacuity discipline).
 *
 * Every helper below is Effect-native — no Promise return types, no raw
 * throws. Errors are mapped into `PropertyFailure` tags before surfacing.
 */
import { Effect, Scope } from "effect";
import {
  JSON_RPC_VERSION,
  type NotificationFrame,
} from "../../../transport/index.js";
import type { TestServerConnection } from "../_shared/driver/test-server.js";
import {
  awaitConnection,
  lookupTagForRawBytes,
  makeClientHandshakeWindow,
  runAutoHandshakeResponder,
  type ClientConformanceRunContext,
  type ClientHandshakeWindow,
  type RealClientHandle,
} from "./runner.js";
import {
  PropertyUnavailable,
  PropertyInvariantViolation,
  type PropertyCategory,
} from "../_shared/registry.js";

function unavailable(
  category: PropertyCategory,
  name: string,
  reason: string,
): PropertyUnavailable {
  return new PropertyUnavailable({ category, name, reason });
}

/**
 * Fixture returned to every property body after the prologue runs.
 * Every field below is safe to use inside `fc.asyncProperty` bodies.
 */
export interface ClientFixture {
  readonly handle: RealClientHandle;
  readonly connection: TestServerConnection;
  readonly window: ClientHandshakeWindow;
}

/**
 * Acquire a live real-client + TestServer connection + handshake window
 * under a nested Scope. Property bodies wrap their assertion in
 * `Effect.scoped(acquireFixture(ctx, ...).pipe(Effect.flatMap(...)))`.
 *
 * Errors are surfaced as `PropertyUnavailable` so a factory fault doesn't
 * masquerade as a property violation.
 */
export function acquireFixture(
  ctx: ClientConformanceRunContext,
  category: PropertyCategory,
  propertyName: string,
): Effect.Effect<ClientFixture, PropertyUnavailable, Scope.Scope> {
  const propertyUnavailable = (reason: string): PropertyUnavailable =>
    unavailable(category, propertyName, reason);

  return Effect.gen(function* () {
    const handle = yield* ctx
      .realClientFactory({ testServerUrl: ctx.testServer.wsUrl })
      .pipe(
        Effect.mapError((e) =>
          propertyUnavailable(`realClient factory: ${String(e.cause)}`),
        ),
      );
    const connection = yield* awaitConnection(ctx.testServer).pipe(
      Effect.mapError((e) =>
        propertyUnavailable(`TestServer.accept: ${String(e.cause)}`),
      ),
    );
    yield* runAutoHandshakeResponder(connection, handle.agentId);
    yield* handle.ready.pipe(
      Effect.mapError((e) =>
        propertyUnavailable(`realClient.ready: ${String(e.cause)}`),
      ),
      Effect.timeoutFail({
        duration: "15 seconds",
        onTimeout: () =>
          propertyUnavailable(
            "real client did not complete handshake within 15s",
          ),
      }),
    );
    const window = yield* makeClientHandshakeWindow(handle);
    return { handle, connection, window } satisfies ClientFixture;
  }).pipe(Effect.withSpan("acquireFixture"));
}

/**
 * Poll a real client's observation stream for notifications whose
 * `params.__emissionTag` matches `tag`. Returns the accumulated tagged
 * observations (possibly empty) after `budgetMs` has elapsed or
 * `expected` matches have arrived, whichever comes first.
 *
 * Used by predicates that need to discriminate real emissions from
 * handshake-window noise.
 */
export interface TaggedObservation {
  readonly tag: string;
  readonly raw: Uint8Array;
  readonly decoded: NotificationFrame;
  readonly params: Readonly<Record<string, unknown>>;
  readonly notificationName: NotificationFrame["method"];
}

export function notificationParamsRecord(
  params: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {};
  }
  return Object.fromEntries(Object.entries(params));
}

function notificationFrameOrNull(value: unknown): NotificationFrame | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const frame = value as Readonly<Record<string, unknown>>;
  return frame["jsonrpc"] === JSON_RPC_VERSION &&
    typeof frame["method"] === "string" &&
    !("id" in frame)
    ? (value as NotificationFrame)
    : null;
}

function filterTagged(
  snap: ReadonlyArray<{
    readonly decoded: unknown;
    readonly rawBytes: Uint8Array;
    readonly emissionTag?: string | null;
  }>,
  predicate: (tag: string) => boolean,
): ReadonlyArray<TaggedObservation> {
  const out: TaggedObservation[] = [];
  for (const o of snap) {
    const decoded = notificationFrameOrNull(o.decoded);
    if (decoded === null) continue;
    const params = notificationParamsRecord(decoded.params);
    // Real adapters set `emissionTag: null` and we look up the tag by
    // wire-bytes match against the runner's emit registry. Divergence-
    // proof fakes preset `emissionTag` directly on the synthesized
    // observation so a harness that rewrites the wire frame still
    // surfaces the original tag for the property's predicate.
    const tag =
      typeof o.emissionTag === "string"
        ? o.emissionTag
        : lookupTagForRawBytes(o.rawBytes);
    if (tag !== null && predicate(tag)) {
      out.push({
        tag,
        raw: o.rawBytes,
        decoded,
        params,
        notificationName: decoded.method,
      });
    }
  }
  return out;
}

export function collectTagged(
  handle: RealClientHandle,
  predicate: (tag: string) => boolean,
  opts: { readonly expected: number; readonly budgetMs: number },
): Effect.Effect<ReadonlyArray<TaggedObservation>> {
  return Effect.gen(function* () {
    const deadline = Date.now() + opts.budgetMs;
    while (Date.now() < deadline) {
      const snap = yield* handle.notifications.snapshot;
      const matched = filterTagged(snap, predicate);
      if (matched.length >= opts.expected) return matched;
      yield* Effect.sleep("25 millis");
    }
    const snap = yield* handle.notifications.snapshot;
    return filterTagged(snap, predicate);
  }).pipe(Effect.withSpan("collectTagged"));
}

/**
 * Build a `PropertyInvariantViolation` for the current property.
 * Convenience so property bodies don't repeat the tagged-error
 * construction.
 */
export function invariant(
  category: PropertyCategory,
  name: string,
  reason: string,
): PropertyInvariantViolation {
  return new PropertyInvariantViolation({ category, name, reason });
}

/**
 * Subscribe the fixture's real client to all notifications (no filter) so the
 * property body can observe every tagged emission. Returns the
 * subscription so the Scope teardown can call `unsubscribe`.
 */
export function subscribeAll(
  handle: RealClientHandle,
): Effect.Effect<void, PropertyUnavailable, Scope.Scope> {
  return Effect.gen(function* () {
    const sub = yield* handle.notifications
      .subscribe()
      .pipe(
        Effect.mapError((e) =>
          unavailable(
            "delivery",
            "subscribe",
            `subscribe failed: ${String(e.cause)}`,
          ),
        ),
      );
    yield* Effect.addFinalizer(() => sub.unsubscribe);
  }).pipe(Effect.withSpan("subscribeAll"));
}
