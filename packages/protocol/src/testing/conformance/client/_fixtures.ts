/**
 * Shared fixture helpers for the client-side property bodies.
 *
 * Every client-side property runs the same prologue:
 *   - `yield* ctx.realClientFactory()` — produce a real MoltZap client
 *   - `yield* awaitConnection(ctx.testServer)` — TestServer accepts the WS
 *   - `yield* runAutoHandshakeResponder(connection, ...)` — respond to
 *     auth/connect so the real client's `ready` Effect resolves
 *   - `yield* window.awaitHandshakeComplete` — wait for ready to settle
 *
 * Centralizing the prologue + teardown here keeps each property body
 * focused on its discriminating predicate (architect-195 / architect-197
 * anti-vacuity discipline).
 *
 * Every helper below is Effect-native — no Promise return types, no raw
 * throws. Errors are mapped into `PropertyFailure` tags before surfacing.
 */
import { Effect, Scope } from "effect";
import type { TestServerConnection } from "../../test-server.js";
import {
  awaitConnection,
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
} from "../registry.js";

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
  const unavailable = (reason: string): PropertyUnavailable =>
    new PropertyUnavailable({
      category,
      name: propertyName,
      reason,
    });

  return Effect.gen(function* () {
    const handle = yield* ctx
      .realClientFactory({ testServerUrl: ctx.testServer.wsUrl })
      .pipe(
        Effect.mapError((e) =>
          unavailable(`realClient factory: ${String(e.cause)}`),
        ),
      );
    const connection = yield* awaitConnection(ctx.testServer).pipe(
      Effect.mapError((e) =>
        unavailable(`TestServer.accept: ${String(e.cause)}`),
      ),
    );
    yield* runAutoHandshakeResponder(connection, handle.agentId);
    yield* handle.ready.pipe(
      Effect.mapError((e) =>
        unavailable(`realClient.ready: ${String(e.cause)}`),
      ),
      Effect.timeoutFail({
        duration: "15 seconds",
        onTimeout: () =>
          unavailable("real client did not complete handshake within 15s"),
      }),
    );
    const window = yield* makeClientHandshakeWindow(handle);
    return { handle, connection, window } satisfies ClientFixture;
  });
}

/**
 * Poll a real client's observation stream for events whose
 * `data.__emissionTag` matches `tag`. Returns the accumulated tagged
 * observations (possibly empty) after `budgetMs` has elapsed or
 * `expected` matches have arrived, whichever comes first.
 *
 * Used by A2, C1, C3, C4, D1, D3, D4, E2 predicates that need to
 * discriminate real emissions from handshake-window noise.
 */
export interface TaggedObservation {
  readonly tag: string;
  readonly raw: Uint8Array;
  readonly data: unknown;
  readonly eventName: string;
}

function filterTagged(
  snap: ReadonlyArray<{
    readonly decoded: { readonly event: string; readonly data?: unknown };
    readonly rawBytes: Uint8Array;
  }>,
  predicate: (tag: string) => boolean,
): ReadonlyArray<TaggedObservation> {
  const out: TaggedObservation[] = [];
  for (const o of snap) {
    const data = o.decoded.data as { __emissionTag?: string } | undefined;
    const tag = data?.__emissionTag;
    if (typeof tag === "string" && predicate(tag)) {
      out.push({
        tag,
        raw: o.rawBytes,
        data,
        eventName: o.decoded.event,
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
      const snap = yield* handle.events.snapshot;
      const matched = filterTagged(snap, predicate);
      if (matched.length >= opts.expected) return matched;
      yield* Effect.sleep("25 millis");
    }
    const snap = yield* handle.events.snapshot;
    return filterTagged(snap, predicate);
  });
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
 * Subscribe the fixture's real client to all events (no filter) so the
 * property body can observe every tagged emission. Returns the
 * subscription so the Scope teardown can call `unsubscribe`.
 */
export function subscribeAll(
  handle: RealClientHandle,
): Effect.Effect<void, PropertyUnavailable, Scope.Scope> {
  return Effect.gen(function* () {
    const sub = yield* handle.events.subscribe({}).pipe(
      Effect.mapError(
        (e) =>
          new PropertyUnavailable({
            category: "delivery",
            name: "subscribe",
            reason: `subscribe failed: ${String(e.cause)}`,
          }),
      ),
    );
    yield* Effect.addFinalizer(() => sub.unsubscribe);
  });
}
