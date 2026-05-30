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
import { Data, type Context, type Effect } from "effect";
import type { ConnectionId } from "../network/actor-model.js";
import type { AgentId } from "../identity/agents.js";
import type { AppId } from "../task/ids.js";

/**
 * Protocol-owned principal union read by `argsOf` resolvers (D #705
 * Decision 2). Tagged so a resolver narrows app-arm vs agent-arm before
 * reading `appId` / `agentId`. The server's `AppContext` / `AgentContext`
 * (`@moltzap/server-core` `transport/context.ts`) satisfy this
 * structurally — their `_tag` / `agentId` / `appId` use these same
 * protocol-owned brands — so the descriptor type can name the principal
 * without protocol importing server.
 */
export type DispatchAuth =
  | { readonly _tag: "AgentContext"; readonly agentId: AgentId }
  | { readonly _tag: "AppContext"; readonly appId: AppId };

/**
 * Per-request context handed to every `argsOf` resolver (D #705 Decision
 * 2). Uniform across all methods (independent of the wire method string),
 * so — unlike `params` — it is compiler-typeable. Replaces the prior
 * `ctx: unknown` + per-site `ctx as ...` casts. The `connection.connId`
 * field matches the server's three-arm `Connection` arm `connId`; the
 * `connection.auth` tagged union mirrors the principal arms.
 */
export interface DispatchContext {
  readonly connection: {
    readonly connId: ConnectionId;
    readonly auth: DispatchAuth;
  };
}

/**
 * Impossible-state defect: a non-agent arm reached {@link callerAgentIdOf}.
 * Every call site is an agent-originated `argsOf` resolver whose binding
 * hands an agent ctx, so this can only surface a wiring defect, never a
 * caller-actionable error. Tagged (not a raw `throw new Error`) so the
 * synchronous `argsOf` boundary still names the failure.
 */
class NonAgentCallerError extends Data.TaggedError("NonAgentCallerError")<{
  readonly arm: DispatchAuth["_tag"];
}> {}

/**
 * Read the AGENT arm's id off the protocol-owned {@link DispatchContext}
 * (D #705 Decision 2). The single shared helper for every agent-originated
 * `argsOf` resolver (`task/request`, `messages/send`, `messages/list`, …):
 * each is bound at a dispatch site that hands an agent ctx, so the
 * `_tag === "AgentContext"` narrowing always succeeds. The narrowing is
 * cast-free — `auth` is the tagged {@link DispatchAuth} union, so the agent
 * arm's `agentId` is reached by discriminant, NOT by an `as { agentId }`
 * assertion. A non-agent arm reaching here is an impossible-state defect
 * (the binding guarantees an agent caller), so it throws the tagged
 * {@link NonAgentCallerError} rather than returning a caller-actionable error.
 */
export const callerAgentIdOf = (ctx: DispatchContext): AgentId => {
  const { auth } = ctx.connection;
  if (auth._tag !== "AgentContext") {
    throw new NonAgentCallerError({ arm: auth._tag });
  }
  return auth.agentId;
};

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
// classes (e.g. `Context.Tag<TaskReadAccess, TaskReadAccessValue>`) are
// NOT assignable to `Context.Tag<unknown, unknown>`. The descriptor stores
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
export type CapabilityProviderTable<Caps extends Context.Tag<any, any>> = {
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
    ? Tag extends Context.Tag<any, any>
      ? Tag
      : never
    : never
  : never;
