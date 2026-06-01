/**
 * @file The single-source server method binding registry — the one typed
 * record per inbound method from which BOTH the native engine handler map AND
 * the principal-kind policy table are projected, so they cannot drift.
 *
 * `callablePrincipal`/`requiresActive` are the #720 principal-kind policy. They
 * live in the `define*Method` wrappers' closures (`define-layered-method.ts`,
 * `context.ts`); each wrapper surfaces them onto its returned slot as a
 * {@link ServerMethodBinding}, instead of discarding them. The native engine's
 * handler map (`serverHandlerMap`) keys each tag to its handler body; the
 * policy table (`principalKinds`) keys each authenticated tag to its policy.
 * Both are projections of the same {@link ServerMethodBindings} tuple
 * (`app/server.ts → makeCoreRpcMethods` assembles it), so a method is in both
 * or neither — never one.
 */
import { isUnauthenticatedMethod, type JsonRpcMethod } from "@moltzap/protocol";
import type { PrincipalKind } from "./context.js";

/**
 * The #720 principal-kind policy a method's gate enforces: which principal arm
 * may call it, and (agent-arm only) whether the agent must be claimed/active.
 * The `principalKinds` table maps each authenticated tag to one of these.
 */
export interface PrincipalKindPolicy {
  readonly callablePrincipal: PrincipalKind;
  readonly requiresActive: boolean;
}

/**
 * One server method's complete binding: its wire tag and the #720 policy. The
 * `define*Method` wrappers already hold `callablePrincipal`/`requiresActive`;
 * this record surfaces them rather than leaving them closure-private. The
 * native engine handler map AND the `principalKinds` policy table are BOTH
 * projections of a tuple of these, so they cannot drift.
 *
 * The handler body is NOT carried here in the additive substrate: the live
 * dispatch still runs through the `ErasedSlot` table. The cutover replaces that
 * table with `ServerEngineRpcGroup.toLayer(serverHandlerMap)`, at which point
 * the binding also carries the per-tag handler body.
 */
export interface ServerMethodBinding<Tag extends string = string> {
  readonly tag: JsonRpcMethod<Tag>;
  readonly callablePrincipal: PrincipalKind;
  readonly requiresActive: boolean;
}

/** A tuple of {@link ServerMethodBinding}s — the single source of truth. */
export type ServerMethodBindings = ReadonlyArray<ServerMethodBinding>;

/**
 * The principal-kind policy table the {@link makePrincipalResolutionLayer} gate
 * reads, keyed by branded wire tag. Built by {@link projectPrincipalKinds} from
 * the authenticated bindings (every binding NOT in `UNAUTHENTICATED_METHODS`).
 * A `get(tag)` miss fails CLOSED (the gate rejects with `ForbiddenError`), never
 * defaults to a permissive `"any"`.
 */
export type PrincipalKindTable = ReadonlyMap<
  JsonRpcMethod,
  PrincipalKindPolicy
>;

/**
 * Impossible-state defect the projection and server boot raise when the binding
 * registry violates the fail-closed partition: an authenticated binding carrying
 * `callablePrincipal: "any"`, or a policy-table key set that does not EXACTLY
 * equal the engine's gated tag set (a method reached the authenticated engine
 * without a policy, or a policy names a tag the group lacks). Either is a wiring
 * bug that must fail loudly, never a silent permissive default. Defense-in-depth
 * behind the type-level partition canary.
 */
export class PrincipalKindRegistryError extends Error {
  override readonly name = "PrincipalKindRegistryError";
}

/**
 * Project the principal-kind policy table from the single-source binding tuple:
 * one entry per AUTHENTICATED binding (every tag NOT in
 * `UNAUTHENTICATED_METHODS`). The unauth methods carry no policy — they run
 * pre-auth via `ConnectionTag`, never the gate — so they are excluded here, and
 * a gate lookup for an unauth tag is itself a wiring defect.
 *
 * This is one of the two projections of {@link ServerMethodBindings}; the engine
 * handler map is the other. Deriving both from the same tuple is the no-drift
 * guarantee: a method is in both projections or neither.
 *
 * An authenticated binding with `callablePrincipal: "any"` is rejected: `"any"`
 * means "no principal to narrow", which is only sound for the unauthenticated
 * Connect path. A gated method carrying `"any"` would provide no
 * `CurrentPrincipal` to a handler that reads one — fail closed at projection.
 */
export const projectPrincipalKinds = (
  bindings: ServerMethodBindings,
): PrincipalKindTable => {
  const table = new Map<JsonRpcMethod, PrincipalKindPolicy>();
  for (const b of bindings) {
    if (isUnauthenticatedMethod(b.tag)) continue;
    if (b.callablePrincipal === "any") {
      throw new PrincipalKindRegistryError(
        `authenticated method has callablePrincipal "any" (only the unauthenticated Connect path may): ${b.tag}`,
      );
    }
    table.set(b.tag, {
      callablePrincipal: b.callablePrincipal,
      requiresActive: b.requiresActive,
    });
  }
  return table;
};

/**
 * Validate at boot that the projected policy table's keys EXACTLY equal the
 * expected gated tag set (the engine's member tags minus the unauth allowlist).
 * Throws {@link PrincipalKindRegistryError} on any missing or stray tag. The
 * type-level partition canary already pins this statically; this is the runtime
 * backstop for a build that somehow skipped the canary.
 */
export const validatePrincipalKinds = (
  table: PrincipalKindTable,
  expectedGatedTags: ReadonlySet<string>,
): void => {
  const actual = new Set<string>(table.keys());
  const missing = [...expectedGatedTags].filter((t) => !actual.has(t));
  const stray = [...actual].filter((t) => !expectedGatedTags.has(t));
  if (missing.length > 0 || stray.length > 0) {
    throw new PrincipalKindRegistryError(
      `principalKinds key mismatch: missing=[${missing.join(", ")}] stray=[${stray.join(", ")}]`,
    );
  }
};
