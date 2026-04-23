/**
 * Property registry — a tiny side-effect hook the tier modules use to
 * stash fast-check properties for the Vitest entry to pick up.
 *
 * Rationale: the tier modules live under `src/testing/` (included in the
 * main `tsc --build`) so they can't import `vitest`. Each tier module
 * calls `registerProperty(ctx, ...)` with a pure Promise-returning body;
 * the Vitest entry file iterates `ctx.registry` and wraps each entry in
 * `it(...)`. This keeps the test-runner coupling out of the build surface
 * (Principle 6 — scope is a hard budget).
 */
import { Ref, Effect } from "effect";
import type { ConformanceRunContext } from "./runner.js";

export interface RegisteredProperty {
  readonly tier: "A" | "B" | "C" | "D" | "E";
  readonly id: string;
  readonly description: string;
  readonly run: () => Promise<void>;
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
  tier: "A" | "B" | "C" | "D" | "E",
  id: string,
  description: string,
  run: () => Promise<void>,
): void {
  const reg = ensureRegistry(ctx);
  Effect.runSync(
    Ref.update(reg.entries, (cur) => [...cur, { tier, id, description, run }]),
  );
}

export function collectProperties(
  ctx: ConformanceRunContext,
): ReadonlyArray<RegisteredProperty> {
  const reg = ensureRegistry(ctx);
  return Effect.runSync(Ref.get(reg.entries));
}
