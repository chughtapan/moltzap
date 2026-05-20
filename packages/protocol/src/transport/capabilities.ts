/**
 * @file Capability metadata + provider-table types — Spec F dispatcher.
 *
 * Shape B (per-definition metadata) source of truth: each `RpcDefinition`
 * carries an OPTIONAL `capabilities` array of `Context.Tag` instances and
 * a `capabilityArgs` resolver. The dispatcher reads these at runtime to
 * thread `Effect.provideServiceEffect` from a `CapabilityProviderTable`.
 *
 * The type-level lockstep gate that prevents a handler's R channel
 * referencing capabilities not in `definition.capabilities` lives in
 * `typed-dispatcher.types-check.ts` (positive canary).
 */
import type { Context, Effect } from "effect";

/**
 * Closed shape of a per-definition capability descriptor.
 *
 * - `tag` is the Spec E `Context.Tag` instance the handler will `yield*`.
 * - `argsOf` reads the inbound `params` and request `ctx` to construct
 *   the args the provider's obtain helper needs. Erased to `unknown` for
 *   storage; the per-definition typing lives on `CapabilityDescriptor&lt;D, Tag&gt;`
 *   below.
 */
// `Context.Tag` is invariant in both type parameters, so concrete tag
// classes (e.g. `Context.Tag<TmAuthority, TmAuthorityValue>`) are NOT
// assignable to `Context.Tag<unknown, unknown>`. The descriptor stores
// the tag for runtime indexing (`tag.key`) + `provideServiceEffect`
// dispatch, both of which only need the variance-agnostic surface
// (`{ key: string }` + `Context.Tag` brand). Widening the slot to
// `Context.Tag<any, any>` lets descriptor literals compile without
// per-tag `as` casts; `CapabilitiesOf<D>` recovers the per-tag union
// downstream via the `infer Cap` pattern.
type AnyContextTag = Context.Tag<any, any>;

export interface CapabilityDescriptor {
  readonly tag: AnyContextTag;
  readonly argsOf: (params: unknown, ctx: unknown) => unknown;
}

/**
 * Provider-table type alias (Spec F G5). Keys are the capability tag's
 * `_tag` string; values are the obtain helper that produces the tag's
 * service value. Spec E #606 owns the inhabitants — Spec F consumes
 * them unchanged.
 *
 * Spec E's obtain helpers have shape
 * `(args) =&gt; Effect.Effect&lt;Service, ObtainError, ObtainContext&gt;`. The
 * dispatcher invokes the provider, then threads
 * `Effect.provideServiceEffect(tag, providerEffect)` for each tag a
 * handler's definition declares.
 *
 * Parameter `Caps` is the union of `Context.Tag` instances referenced
 * across all slots in the handler table; the factory rejects (TS2741) a
 * provider table missing any tag in `Caps`.
 */
export type CapabilityProviderTable<
  Caps extends Context.Tag<unknown, unknown>,
> = {
  readonly [Cap in Caps as Cap extends Context.Tag<infer Id, infer _Svc>
    ? Id extends string
      ? Id
      : never
    : never]: (
    args: unknown,
  ) => Effect.Effect<
    Cap extends Context.Tag<unknown, infer Svc> ? Svc : never,
    unknown,
    unknown
  >;
};

/**
 * Type-level extractor: union of capability tags declared on definition `D`
 * via `D["capabilities"][number]["tag"]`. When `D["capabilities"]` is
 * absent (the spec F stub state, before impl-staff per-method updates),
 * resolves to `never` — the slot contributes no capability requirements.
 */
export type CapabilitiesOf<D> = D extends {
  readonly capabilities: ReadonlyArray<infer Cap>;
}
  ? Cap extends { readonly tag: infer Tag }
    ? Tag extends Context.Tag<unknown, unknown>
      ? Tag
      : never
    : never
  : never;
