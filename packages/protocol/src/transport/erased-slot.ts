/**
 * @file Cast-free erased slot — #705 HALF-1.
 *
 * The dispatcher (`dispatch.ts → makeInboundDispatch`) indexes inbound
 * RPC slots by the runtime `frame.method` string. That lookup is
 * wire-dynamic — a remote can name any string — so the table value must
 * be an existential: the per-method `params`/`result`/`capabilities`
 * types are bound at REGISTRATION, not at the dispatch boundary.
 *
 * Pre-HALF-1 the registry was a homogeneous `RpcMethodBinding[]`
 * (a `HandlerSlot&lt;…, Context.Tag&lt;unknown, unknown>>`) whose typed triple
 * was decomposed and reassembled through a cascade of type-erasure
 * casts (`eraseHandlerTable` / `eraseProviderTable` / `asNeverR` /
 * `buildServerHandlers`'s erasure into `ServerHandlers`). HALF-1 stops
 * decomposing the triple: each typed `(definition, handler, providers)`
 * is wrapped into a real {@link ErasedSlot} at the wrap site, where the
 * capability tuple `CapsTuple` is bound. The slot's `invoke`:
 *   1. decodes `params` via the method's OWN AJV validator (a genuine
 *      `d is Static&lt;P>` narrowing, not an assertion);
 *   2. discharges THIS method's declared capabilities in declaration
 *      order, threading the slot's own typed providers
 *      ({@link CapProviders}, a positional tuple aligned to
 *      `definition.capabilities`);
 *   3. runs the typed handler and returns its {@link Exit}.
 *
 * The slot boundary is honestly typed: `invoke`'s residual `R` is `Env`
 * (the `FullLive` service-tag union the dispatcher's `ManagedRuntime`
 * resolves at request time), NOT `never` — there is no `asNeverR` lie.
 * The per-frame capabilities are discharged INSIDE; only the service
 * `Env` rides out to the runtime.
 *
 * ## The two-axis lockstep (reproduces the retired Canary 7 on live code)
 *
 * The factory carries the cast-free version of the
 * `HandlerSlot&lt;D, Ctx, Caps>` lockstep that the never-instantiated
 * `ServerHandlers` table proved, in TWO non-vacuous obligations both
 * bound where `CapsTuple` is known:
 *   - **handler R ⊆ `Env | CapIdentsOf&lt;CapsTuple>`** — a handler that
 *     `yield*`s a capability tag not in the declared tuple widens its R
 *     past the upper bound and fails the parameter type (the R⊆Caps half).
 *   - **`providers: CapProviders&lt;CapsTuple, Env>`** — a positional tuple
 *     forcing exactly one provider per declared cap, in declaration
 *     order, each yielding that cap's Service value (the value half). A
 *     missing provider is a tuple-arity mismatch; a wrong-service
 *     provider is an element-type mismatch.
 *
 * Both halves are verified to FIRE against the repo's class-style
 * capability tags (`Context.Tag("@moltzap/protocol/…")` — for a class
 * tag, `Context.Tag.Identifier&lt;Tag>` is the `Self` instance type, NOT
 * the string key, so a record keyed off the tag would be vacuous; the
 * positional tuple is not). `Env` MUST be pinned by the caller — a free
 * `Env` widens to swallow an undeclared cap and the R⊆Caps half goes
 * false-green (the canary turbofishes a concrete `Env`; the wrappers in
 * `define-layered-method.ts` pin their layer service-tag union).
 *
 * HALF-2 (deferred) types away the runtime `table[method]` lookup with a
 * discriminated `WireFrame` union + a typed `Match`-over-methods, which
 * also makes the capability discharge static and removes the lone
 * {@link dischargeCaps} carve-out below.
 */
import { Data, Effect, Exit, type Context } from "effect";
import { type Static, type TSchema } from "@sinclair/typebox";

import { decodeRpcParams, type RpcDefinition } from "./method.js";
import type { CapabilityDescriptor, DispatchContext } from "./capabilities.js";

/**
 * The dispatcher-boundary `ctx` the slot's `invoke` receives. Structural
 * mirror of the SERVER `DispatchContext`
 * (`@moltzap/server-core` `transport/context.ts → DispatchContext`) — the
 * live THREE-arm `Connection` union whose unauthenticated arm has no
 * `auth`. The slot narrows `ctx.connection._tag` INSIDE `invoke` (the
 * #720 principal-kind gate); it MUST be the 3-arm union because the
 * Connect frame (`agent/connect` / `app/connect`) is dispatched while the
 * arm is still unauthenticated, so the unauth arm reaches `invoke`
 * unnarrowed. The protocol `DispatchContext` (`capabilities.ts`) is a
 * DIFFERENT type for a DIFFERENT role — the `argsOf` resolver context
 * (Decision 2) — and requires `auth`, so it cannot stand in here.
 *
 * Kept structural (not an import of the server type) so the protocol
 * package does not depend on `@moltzap/server-core`. The slot factory is
 * generic over `Conn`, which the server pins to its `Connection` union.
 */
export interface SlotDispatchContext<Conn> {
  readonly connection: Conn;
}

/**
 * Existential slot the dispatcher indexes by runtime method string.
 *
 * `Env` is the `FullLive` service-tag union the dispatcher's
 * `ManagedRuntime` resolves at request time (the layer service tags
 * MINUS the per-frame capability tags, which are discharged inside
 * `invoke`). `Conn` is the server's three-arm `Connection` union.
 *
 * `invoke` decodes `params` via the method's own AJV validator, threads
 * THIS method's declared capability providers in declaration order, runs
 * the typed handler, and returns the `Exit`. `R = Env` (NOT `never`):
 * capabilities are already discharged; the `ManagedRuntime&lt;FullLive>`
 * provides `Env`. NO double-erasure cast, NO `Context.Tag&lt;unknown, unknown>`.
 */
export interface ErasedSlot<Env, Conn> {
  readonly definition: RpcDefinition<string, TSchema, TSchema>;
  readonly invoke: (
    params: unknown,
    ctx: SlotDispatchContext<Conn>,
  ) => Effect.Effect<Exit.Exit<unknown, unknown>, never, Env>;
}

/**
 * The keyed table the dispatcher indexes by runtime method string. The
 * `| undefined` value type makes the wire-dynamic lookup honest: an
 * unknown method string yields `undefined` → wire `MethodNotFound`
 * -32601. HALF-2 types this away.
 */
export type ErasedSlotTable<Env, Conn> = Readonly<
  Record<string, ErasedSlot<Env, Conn> | undefined>
>;

/**
 * Per-cap provider: obtain the `Effect` yielding the tag's Service value.
 * `R = Env` (the provider obtains under the `ManagedRuntime` env, NOT a
 * capability — capabilities are what providers DISCHARGE, they cannot
 * themselves require one).
 */
type ProviderFor<Cap, Env> =
  Cap extends Context.Tag<any, infer Svc>
    ? (args: unknown) => Effect.Effect<Svc, unknown, Env>
    : never;

/**
 * NON-VACUOUS providers obligation: a positional tuple correlated to the
 * descriptor's `capabilities` tuple. Element `I` provides the `I`-th
 * declared cap. A MISSING provider is a tuple-arity mismatch; a
 * WRONG-service provider is an element-type mismatch. Both FIRE for the
 * repo's class-style tags — the equivalent mapped-type keyed by the tag
 * Identifier does NOT (the class-tag Identifier is `Self`, a brand type,
 * not a string key, so the mapped type collapses to `{}`).
 */
export type CapProviders<
  CapsTuple extends ReadonlyArray<CapabilityDescriptor>,
  Env,
> = {
  readonly [I in keyof CapsTuple]: CapsTuple[I] extends {
    readonly tag: infer Tag;
  }
    ? ProviderFor<Tag, Env>
    : never;
};

/**
 * Identifier union of the declared caps — the handler R upper bound.
 * Projects to the Tag Identifier (= `Self` for a class tag), the type a
 * real handler's R channel actually holds (NOT the Tag VALUE type
 * `typeof X`). `CapsTuple[number]["tag"]` is the union of the declared
 * tags; `Context.Tag.Identifier` projects each to its `Self`.
 */
export type CapIdentsOf<CapsTuple extends ReadonlyArray<CapabilityDescriptor>> =
  Context.Tag.Identifier<CapsTuple[number]["tag"]>;

/**
 * Build a real {@link ErasedSlot} from a typed `(definition, handler,
 * providers)` triple. `CapsTuple` is sourced from the `defineRpc` RETURN
 * shape (`& { readonly capabilities: CapsTuple }`) so it is the literal
 * tuple, never `never`. `Env` MUST be supplied concretely by the caller
 * (the wrapper supplies its layer service-tag union; a canary turbofishes
 * a concrete union) — a FREE `Env` widens to swallow an undeclared cap in
 * the handler's R and the R⊆Caps negative goes false-green. `Env` is the
 * LAST generic so the turbofish stays ergonomic; do NOT rely on inference
 * for it.
 *
 * Lockstep obligations (both bound here, both verified to fire on
 * class-tags):
 *   - `handler` R upper bound = `Env | CapIdentsOf&lt;CapsTuple>` (R⊆Caps).
 *   - `providers: CapProviders&lt;CapsTuple, Env>` (one typed provider per
 *     declared cap, positional).
 *
 * For the no-capability case (`capabilities: readonly []`):
 * `CapsTuple = readonly []`, `CapIdentsOf&lt;readonly []> = never`, the
 * handler R upper bound is `Env`, and `providers` is the empty tuple `[]`.
 */
export function makeErasedSlot<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
  E,
  Conn,
  CapsTuple extends ReadonlyArray<CapabilityDescriptor>,
  Env, // pinned by caller (wrapper layer-tag union / canary turbofish) — NEVER left free
>(
  // `Omit<…, "capabilities">` strips `RpcDefinition`'s WIDE optional
  // `capabilities?: ReadonlyArray<CapabilityDescriptor>` so the
  // intersection does NOT poison `CapsTuple` with a `& CapabilityDescriptor[]`
  // arm (whose tag Identifier is `any`, which would swallow every
  // undeclared cap and make the R⊆Caps lockstep false-green). `defineRpc`'s
  // return type is `Omit`'d the same way so `definition.capabilities` is the
  // clean tuple this signature requires.
  definition: Omit<RpcDefinition<Name, P, R>, "capabilities"> & {
    readonly capabilities: CapsTuple;
  },
  // `CapsTuple` and `Env` are inferred ONLY from `definition` + `providers`;
  // `NoInfer` blocks the handler's R-channel from driving their inference.
  // Without it, a handler that `yield*`s an undeclared cap would let TS
  // WIDEN `CapsTuple`/`Env` to admit that cap and the R⊆Caps lockstep
  // would go false-green (the slot factory's whole point is that it bites).
  handler: (
    params: Static<P>,
    ctx: SlotDispatchContext<Conn>,
  ) => Effect.Effect<Static<R>, E, NoInfer<Env | CapIdentsOf<CapsTuple>>>,
  providers: CapProviders<CapsTuple, Env>,
): ErasedSlot<Env, Conn> {
  const invoke = (
    params: unknown,
    ctx: SlotDispatchContext<Conn>,
  ): Effect.Effect<Exit.Exit<unknown, unknown>, never, Env> =>
    Effect.gen(function* () {
      const decoded = yield* Effect.exit(decodeRpcParams(definition, params));
      if (Exit.isFailure(decoded)) {
        return decoded;
      }
      const discharged = dischargeCaps<Static<R>, E, Conn, CapsTuple, Env>({
        effect: handler(decoded.value, ctx),
        capabilities: definition.capabilities,
        providers,
        params: decoded.value,
        ctx,
      });
      return yield* Effect.exit(discharged);
    }).pipe(Effect.withSpan("ErasedSlot.invoke"));
  return { definition, invoke };
}

interface DischargeArgs<
  Result,
  E,
  Conn,
  CapsTuple extends ReadonlyArray<CapabilityDescriptor>,
  Env,
> {
  readonly effect: Effect.Effect<Result, E, Env | CapIdentsOf<CapsTuple>>;
  readonly capabilities: CapsTuple;
  readonly providers: CapProviders<CapsTuple, Env>;
  readonly params: Static<TSchema>;
  readonly ctx: SlotDispatchContext<Conn>;
}

/**
 * Impossible-state defect: the discharge boundary handed `argsOf` a
 * connection arm that is NOT an authenticated principal (D #705 #720,
 * the CP-B fold-in). The #720 principal-kind gate runs in the SERVER's
 * slot wrapper (`define-layered-method.ts → defineXMethod`, via
 * `defineMethod`'s `narrowPrincipalCtx`) and rejects a non-agent/non-app
 * arm with `ForbiddenError` BEFORE the cap-bearing handler runs, so a
 * cap-bearing slot only reaches {@link narrowToDispatchContext} on an
 * authenticated arm. Tagged (not a raw throw) so the synchronous
 * `argsOf` boundary names the wiring failure.
 */
class UnauthenticatedDischargeError extends Data.TaggedError(
  "UnauthenticatedDischargeError",
)<{ readonly arm: string }> {}

/**
 * Narrow the slot-boundary connection arm to the protocol-owned 2-arm
 * {@link DispatchContext} that `argsOf` resolvers consume (D #705
 * Decision 2). `argsOf` reads `connection.auth` (the tagged principal
 * union) to derive a provider's args; the slot ctx
 * (`SlotDispatchContext&lt;Conn&gt;`) carries the THREE-arm connection whose
 * unauthenticated arm has no `auth`. Cap-bearing slots only reach here
 * AFTER the #720 principal gate narrowed to an agent/app arm, so the
 * authenticated `auth` is present by construction; an unauthenticated
 * arm is an impossible-state wiring defect (throws the tagged error).
 *
 * The arm narrowing is structural (the `auth._tag` discriminant probe,
 * not an `as DispatchContext` assertion on the input). The lone residual
 * is the `connId` BRAND (`ConnectionId = string & Brand`) plus the
 * `auth` tagged-union re-derivation: the runtime value IS a real
 * authenticated `Connection` arm (the #720 gate + the live arm guarantee
 * it), but TS cannot re-derive the brand/tag from a structural read of
 * `unknown`. That single re-projection is the SAME irreducible boundary
 * as {@link dischargeCaps}'s R-subtraction (both type-level-unprovable,
 * runtime-true facts). HALF-2's typed `Match`-over-methods makes the slot
 * ctx statically the authenticated arm and removes this.
 */
function narrowToDispatchContext(ctx: {
  readonly connection: unknown;
}): DispatchContext {
  const { connection } = ctx;
  if (connection === null || typeof connection !== "object") {
    throw new UnauthenticatedDischargeError({ arm: "non-object-connection" });
  }
  const auth = (connection as { readonly auth?: unknown }).auth;
  if (auth === null || typeof auth !== "object") {
    throw new UnauthenticatedDischargeError({ arm: "missing-auth" });
  }
  const tag = (auth as { readonly _tag?: unknown })._tag;
  if (tag !== "AgentContext" && tag !== "AppContext") {
    throw new UnauthenticatedDischargeError({ arm: String(tag) });
  }
  // IRREDUCIBLE carve-out (same boundary as `dischargeCaps`): the
  // `auth._tag` probe above PROVED the authenticated 2-arm union at
  // runtime, and the live `Connection` arm carries a branded `connId`,
  // but TS cannot re-derive the `ConnectionId` brand + `DispatchAuth` tag
  // from a structural read of `unknown`. HALF-2's typed Match removes it.
  //
  // Return the `{ connection }` WRAPPER (`ctx`), not the bare `connection`:
  // `DispatchContext` is `{ connection: { connId, auth } }` and the `argsOf`
  // resolvers read `ctx.connection.auth` (see `callerAgentIdOf`). The probe
  // above narrowed `ctx.connection`, so `ctx` itself is the DispatchContext.
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- argsOf-ctx narrow: `auth._tag` runtime-proved authenticated 2-arm (the #720 gate guarantees it); TS cannot re-brand connId / re-tag auth from a structural `unknown` read; same irreducible boundary as dischargeCaps, HALF-2 makes it static
  return ctx as unknown as DispatchContext; // #ignore-sloppy-code[as-unknown-as]: argsOf-ctx narrow — `ctx.connection.auth._tag` runtime-proved authenticated 2-arm (#720 gate guarantees it); return the `{ connection }` wrapper that `argsOf` resolvers read; TS cannot re-brand connId / re-tag auth from a structural `unknown` read; same irreducible boundary as dischargeCaps, HALF-2 makes it static
}

/**
 * The ONE irreducible carve-out in the cast-free dispatch path.
 *
 * Discharges the handler's declared per-frame capabilities by folding
 * `Effect.provideServiceEffect(cap.tag, provider(cap.argsOf(params, ctx)))`
 * over `definition.capabilities` in declaration order — the same runtime
 * mechanics as the pre-HALF-1 `applyCapabilityProvisioning`, but the
 * providers are now the slot's OWN typed {@link CapProviders} tuple
 * (closed over, positionally aligned to the descriptor list).
 *
 * IRREDUCIBLE: the runtime fold over `ReadonlyArray&lt;CapabilityDescriptor>`
 * cannot prove per-step that it subtracts exactly the declared caps from
 * `R` — TS does not correlate the array-iteration count with the
 * `CapsTuple` members, so the accumulator's `R` retains the cap union
 * (verified by spike: an honest-typed `reduce&lt;Acc>` leaves residual
 * `R = Env | CapIdentsOf&lt;CapsTuple>`, NOT assignable to `Env`). The
 * `providers: CapProviders&lt;CapsTuple, Env>` PARAMETER is the type-level
 * proof that EVERY declared cap has a matching provider (positional
 * tuple, arity + service-type checked — both verified to fire on
 * class-tags); the fold drains every descriptor cap in declaration order;
 * therefore residual `R = Env`. HALF-2's typed `Match`-over-methods makes
 * this discharge STATIC and removes the assertion.
 */
function dischargeCaps<
  Result,
  E,
  Conn,
  CapsTuple extends ReadonlyArray<CapabilityDescriptor>,
  Env,
>(
  args: DischargeArgs<Result, E, Conn, CapsTuple, Env>,
): Effect.Effect<Result, E, Env> {
  const { effect, capabilities, providers, params, ctx } = args;
  // `providers` is a positional tuple aligned 1:1 with `capabilities`
  // (the type-level lockstep). The runtime backstop skips a missing
  // provider (unreachable when the type-level tuple is satisfied — a
  // defensive guard, not a code path the lockstep admits).
  const providerList = providers as ReadonlyArray<
    (args: unknown) => Effect.Effect<unknown, unknown, Env>
  >;
  // Apply in REVERSE declaration order so the FIRST-declared provider
  // becomes the OUTERMOST `provideServiceEffect` — matching the
  // "sequential, declaration-order, first-failure short-circuit" contract:
  // the first provider runs first; its failure short-circuits without
  // running later providers' obtain helpers.
  let drained: Effect.Effect<Result, unknown, Env | CapIdentsOf<CapsTuple>> =
    effect;
  for (let i = capabilities.length - 1; i >= 0; i -= 1) {
    const cap = capabilities[i];
    const provider = providerList[i];
    if (cap === undefined || provider === undefined) {
      continue;
    }
    const providerEffect: Effect.Effect<unknown, unknown, Env> = provider(
      cap.argsOf(params, narrowToDispatchContext(ctx)),
    );
    drained = Effect.provideServiceEffect(drained, cap.tag, providerEffect);
  }
  // IRREDUCIBLE carve-out (see JSDoc): the runtime fold's R cannot be
  // proved to subtract exactly the declared caps; the positional
  // `providers` tuple is the type-level proof every cap is discharged.
  // HALF-2's static Match-over-methods removes this.
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- runtime-fold R-subtraction is type-level-proved irreducible (positional CapProviders tuple proves total discharge; TS cannot correlate array-iteration count with CapsTuple); HALF-2 makes it static
  return drained as unknown as Effect.Effect<Result, E, Env>; // #ignore-sloppy-code[as-unknown-as]: runtime-fold R-subtraction is type-level-proved irreducible (positional CapProviders tuple proves total discharge); HALF-2 makes it static
}
