/**
 * Property registry — conformance modules publish `PropertyRun` effects
 * here; the vitest entry consumes them.
 *
 * Principle 3 (errors typed, not thrown): every property body is an
 * `Effect.Effect<void, PropertyFailure>`. Failures are tagged — never
 * bare `throw`s. Fast-check's Promise-based `fc.assert` is bridged via
 * `Effect.tryPromise` at each call site so rejections become typed
 * `PropertyAssertionFailure`s.
 *
 * Principle 6 (scope is a hard budget): this module lives under
 * `src/testing/` (included in the main `tsc --build`). It must NOT
 * import `vitest`; the vitest entry does the Promise-boundary adaptation
 * outside the build surface.
 */
import { Data, Effect, Ref } from "effect";
import type { ConformanceRunContext } from "./runner.js";

/**
 * Semantic category each property belongs to. Categories match the five
 * conformance modules; the spec's tier grouping (A/B/C/D/E) is noted
 * once per module header, never in code.
 */
export type PropertyCategory =
  | "schema-conformance"
  | "rpc-semantics"
  | "delivery"
  | "adversity"
  | "boundary";

/** Fast-check / runtime assertion failed for a specific property. */
export class PropertyAssertionFailure extends Data.TaggedError(
  "ConformancePropertyAssertionFailure",
)<{
  readonly category: PropertyCategory;
  readonly name: string;
  readonly cause: unknown;
}> {}

/** Property references infrastructure that isn't available this run. */
export class PropertyUnavailable extends Data.TaggedError(
  "ConformancePropertyUnavailable",
)<{
  readonly category: PropertyCategory;
  readonly name: string;
  readonly reason: string;
}> {}

/** Property is a tombstone for deferred work (e.g. #186 backpressure). */
export class PropertyDeferred extends Data.TaggedError(
  "ConformancePropertyDeferred",
)<{
  readonly category: PropertyCategory;
  readonly name: string;
  readonly followUp: string;
}> {}

/** Property's own invariant (oracle, coverage) failed. */
export class PropertyInvariantViolation extends Data.TaggedError(
  "ConformancePropertyInvariantViolation",
)<{
  readonly category: PropertyCategory;
  readonly name: string;
  readonly reason: string;
}> {}

/** Discriminated union of every failure the registry can surface. */
export type PropertyFailure =
  | PropertyAssertionFailure
  | PropertyUnavailable
  | PropertyDeferred
  | PropertyInvariantViolation;

/** Each property's body — an Effect that succeeds on pass, fails typed on failure. */
export type PropertyRun = Effect.Effect<void, PropertyFailure>;

export interface RegisteredProperty {
  readonly category: PropertyCategory;
  readonly name: string;
  readonly description: string;
  readonly run: PropertyRun;
}

/** Mutable registry attached per-context. */
export interface PropertyRegistry {
  readonly entries: Ref.Ref<ReadonlyArray<RegisteredProperty>>;
}

const registries = new WeakMap<ConformanceRunContext, PropertyRegistry>();

function ensureRegistry(ctx: ConformanceRunContext): PropertyRegistry {
  let reg = registries.get(ctx);
  if (reg === undefined) {
    reg = {
      entries: Effect.runSync(Ref.make<ReadonlyArray<RegisteredProperty>>([])),
    };
    registries.set(ctx, reg);
  }
  return reg;
}

export function registerProperty(
  ctx: ConformanceRunContext,
  category: PropertyCategory,
  name: string,
  description: string,
  run: PropertyRun,
): void {
  const reg = ensureRegistry(ctx);
  Effect.runSync(
    Ref.update(reg.entries, (cur) => [
      ...cur,
      { category, name, description, run },
    ]),
  );
}

export function collectProperties(
  ctx: ConformanceRunContext,
): ReadonlyArray<RegisteredProperty> {
  const reg = ensureRegistry(ctx);
  return Effect.runSync(Ref.get(reg.entries));
}

/**
 * Bridge fast-check's Promise-based `fc.assert` into the Effect error
 * channel. Every tier module uses this wrapper — no direct `await
 * fc.assert(...)` at call sites.
 */
export function assertProperty(
  category: PropertyCategory,
  name: string,
  body: () => Promise<void>,
): PropertyRun {
  return Effect.tryPromise({
    try: body,
    catch: (cause) => new PropertyAssertionFailure({ category, name, cause }),
  });
}
