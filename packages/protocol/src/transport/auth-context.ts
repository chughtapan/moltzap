/**
 * @file Per-method `AuthContext` proof tags — the value a request's
 * `AuthMiddleware` provides into its handler's Context (one unified native
 * middleware per authenticated method, principal gate + caps inside it).
 *
 * Each authenticated method carries ONE `RpcMiddleware` (`auth-middleware.ts`)
 * whose `provides` is that method's `AuthContext` proof tag. The middleware
 * impl resolves the principal, runs the method's declared caps WITH the
 * principal in scope, and provides the combined proof: `{ principal }` plus one
 * field per declared cap. The handler reads `yield*` its method's proof tag and
 * pulls the narrowed principal + each cap proof off it.
 *
 * The proof VALUE shape is DERIVED from the descriptor's `callablePrincipal`
 * (the principal arm) and `caps` tuple (a mapped type, {@link CapProofs}), so it
 * cannot drift from the single descriptor source: a cap added to `caps` adds its
 * proof field; a `callablePrincipal` flip narrows `principal` to the other arm.
 */
import { Context } from "effect";
import type { AgentId } from "../identity/agents.js";
import type { AppId } from "../task/ids.js";
import type { CallablePrincipal, RpcCapTag } from "./method.js";

/**
 * The method-narrowed principal arm carried by a method's proof: the agent arm
 * for `callablePrincipal: "agent"`, the app arm for `"app"`. The middleware
 * gate narrows the live connection to exactly this arm, so the handler reads
 * `auth.principal.agentId` / `auth.principal.appId` with no re-check.
 *
 * `"any"` resolves to `never`: the lone unauthenticated method
 * (`network/connect`) carries no proof — it reads the live arm via
 * `ConnectionTag` — so it never instantiates an `AuthContext`.
 */
export type PrincipalForKind<K extends CallablePrincipal> = K extends "agent"
  ? { readonly _tag: "AgentContext"; readonly agentId: AgentId }
  : K extends "app"
    ? { readonly _tag: "AppContext"; readonly appId: AppId }
    : never;

/**
 * The cap-proof fields a method's `AuthContext` carries: one field per declared
 * cap, keyed by the cap tag's own string `key` (the `Context.Tag` identifier
 * string, e.g. `"@moltzap/protocol/ConversationInTask"`) and valued by the cap's
 * `Context.Tag.Service`. The middleware impl runs each cap's derive/obtain and
 * writes its value here, so a handler reads the cap value off the combined proof
 * (`proof[ConversationInTask.key]`) rather than `yield`-ing the cap's own Tag.
 *
 * Keying by `key` (a string literal) is what makes the proof index-readable: a
 * cap tag's `Context.Tag.Identifier` is the tag's `Self` INSTANCE type, an object
 * type that is not a valid index key. The `key` is the same single identifier
 * `@effect/rpc` uses to route the Tag, so the proof field and the cap stay in
 * lockstep with no separate name map.
 *
 * The mapped type intersects one single-key object per tuple element, collapsing
 * to the record `{ [key]: Service }`. An empty `caps` tuple yields
 * `Record&lt;never, never&gt;` — a cap-less authenticated method's proof is just
 * `{ principal }`.
 */
export type CapProofs<Caps extends ReadonlyArray<RpcCapTag>> =
  Caps extends readonly [infer Head, ...infer Tail]
    ? Head extends RpcCapTag
      ? Tail extends ReadonlyArray<RpcCapTag>
        ? {
            readonly [P in CapKey<Head>]: Context.Tag.Service<Head>;
          } & CapProofs<Tail>
        : never
      : never
    : Record<never, never>;

/**
 * A cap tag's string identifier (`Context.Tag`'s `key`) — the index key its
 * proof field carries in {@link CapProofs}. A class `Context.Tag` exposes its
 * identifier as a string-literal `key`; a non-tag carrier degrades to `string`,
 * which the `caps` tuple's `RpcCapTag` constraint excludes at every real call.
 */
type CapKey<C extends RpcCapTag> = C extends {
  readonly key: infer K extends string;
}
  ? K
  : never;

/**
 * The combined proof value a method's `AuthMiddleware` provides: the
 * method-narrowed principal plus the cap proofs derived from its `caps` tuple.
 * The handler reads `principal` (narrowed, no kind re-check) and each cap value
 * by the cap tag's identifier.
 */
export type AuthContextValue<
  K extends CallablePrincipal,
  Caps extends ReadonlyArray<RpcCapTag>,
> = {
  readonly principal: PrincipalForKind<K>;
} & CapProofs<Caps>;
