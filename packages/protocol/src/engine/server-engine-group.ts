/**
 * @file The server engine's middleware-attached `RpcGroup` and the
 * unauthenticated-method allowlist that partitions it.
 *
 * `ServerEngineRpcGroup` is the group {@link server-engine.ServerEngineLayer}
 * binds: every member EXCEPT those in {@link UNAUTHENTICATED_METHODS} carries that
 * method's OWN `*AuthMw` middleware (the per-method principal-kind gate + caps,
 * `auth-middleware.ts`), looked up by tag in {@link authMiddlewareByMethod}.
 *
 * The partition is total and compiler-checked
 * (`server-engine-group.types-check.ts`): every catalog tag is in exactly one
 * partition (carries its `*AuthMw` XOR is unauth-allowlisted), so a new
 * authenticated method that forgets its `*AuthMw` registry entry is in neither and
 * fails the build.
 *
 * The group is catalog-derived (`serverRpcMethods`); every catalog method is
 * WS-dispatched. The server's single-source binding registry gives each member a
 * handler body; its `principalKinds` policy table is validated at boot against
 * this group's gated members (every binding tag is a group member).
 */
import { Rpc, RpcGroup } from "@effect/rpc";
import type { Schema } from "effect";
import type { RpcDefinition } from "../transport/method.js";
import { serverRpcMethods } from "./rpc-method-groups.js";
import {
  capRequirementsOf,
  principalRequirementOf,
  type Requirement,
} from "./requirements.js";
import type { JsonRpcMethod } from "../transport/method.js";
import {
  PrincipalGateMw,
  requirementMiddleware,
  type MwStackFor,
} from "./cap-middlewares.js";

/**
 * The ONLY methods callable on an unauthenticated connection. Built WITHOUT any
 * `*AuthMw` (no principal exists pre-auth); they read the live 3-arm `Connection`
 * via `ConnectionTag`. EXHAUSTIVE: every other catalog method is
 * authenticated and carries its `*AuthMw`. Adding a method here is a deliberate,
 * reviewed security decision — the partition canary
 * (`server-engine-group.types-check.ts`) FAILS the build if a method is in
 * neither partition or both.
 */
export const UNAUTHENTICATED_METHODS = ["network/connect"] as const;

/** A plain (unbranded) member of {@link UNAUTHENTICATED_METHODS}. */
export type UnauthenticatedMethod = (typeof UNAUTHENTICATED_METHODS)[number];

/**
 * Whether a wire tag is in {@link UNAUTHENTICATED_METHODS} — the single
 * membership check both the engine-group construction (which omits the gate
 * for these) and the server's `principalKinds` projection (which omits them
 * from the policy table) share, so the two agree on the partition by
 * construction.
 */
export const isUnauthenticatedMethod = (tag: string): boolean =>
  (UNAUTHENTICATED_METHODS as readonly string[]).includes(tag);

// The engine binds the live catalog descriptors, whose `requires` are built
// from the concrete requirement tags. The wire-layer `RpcDefinition` erases
// `requires` to the structural `RequirementShape`; the engine re-pins the 4th
// type arg to the genuine `Requirement` union so the classifiers
// (`capRequirementsOf` / `principalRequirementOf`) read the concrete tags.
type AnyRpcDefinition = RpcDefinition<
  string,
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext,
  ReadonlyArray<Requirement>
>;

/**
 * The engine member a single descriptor maps to: its branded wire `name` is the
 * member tag, `paramsSchema`/`resultSchema` are payload/success verbatim, the
 * method's own `errorSchema` (its `_tag`-discriminated error union) is the error
 * Schema, and the 5th (`Middleware`) param is that method's OWN `*AuthMw`
 * (looked up in
 * {@link AuthMiddlewareByMethod} by the tag). An unauthenticated method
 * ({@link UNAUTHENTICATED_METHODS}) carries no middleware. The per-tag
 * conditional makes the partition type-level: any other tag (authenticated WS
 * method) resolves via the registry, so a method that forgets its `*AuthMw`
 * registry entry is unmatched there and the partition canary fails.
 */
type EngineRpcFromDef<D> =
  D extends RpcDefinition<infer Name, infer P, infer R, infer Requires>
    ? Name extends UnauthenticatedMethod
      ? Rpc.Rpc<JsonRpcMethod<Name>, P, R, Schema.Schema.AnyNoContext>
      : Rpc.Rpc<
          JsonRpcMethod<Name>,
          P,
          R,
          Schema.Schema.AnyNoContext,
          MwStackFor<Requires>
        >
    : never;

/**
 * The per-member tuple the server catalog maps to, homomorphic over its
 * `as const` tuple so each member keeps its own tag/payload/success/middleware
 * types per slot. Same shape {@link rpc-method-groups.GroupMembers} uses, with
 * the per-tag `*AuthMw` attachment folded in.
 */
type EngineMembers<Defs extends readonly AnyRpcDefinition[]> = {
  readonly [K in keyof Defs]: EngineRpcFromDef<Defs[K]>;
};

/**
 * Build one engine member from a descriptor: an `Rpc.make` stacked with one
 * `RpcMiddleware` per `requires` entry. The empty `requires` (`network/connect`)
 * carries no middleware. The correspondence is by construction — each
 * requirement's middleware comes from the TOTAL {@link requirementMiddleware}
 * map, so a requirement can never be left ungated (a missing entry is a compile
 * error at the map's `satisfies`), and no boot-time gating walk is needed.
 */
const buildEngineMember = (definition: AnyRpcDefinition) => {
  // The engine member's wire `error` is the HANDLER-DOMAIN union only. Each
  // stacked middleware contributes its own `failure` (principal-gate errors,
  // each cap's errors), which the engine unions into the method's error
  // (`Rpc.ErrorSchema = _Error | _Middleware`). The handler enumerates nothing
  // beyond what it raises itself.
  const member = Rpc.make(definition.name, {
    payload: definition.paramsSchema,
    success: definition.resultSchema,
    error: definition.handlerErrorSchema,
  });
  const requires = definition.requires;
  // No principal head (only `network/connect`, empty `requires`) → no gate, no
  // cap middleware: the member is dispatched unauthenticated.
  if (principalRequirementOf(requires) === undefined) {
    return member;
  }
  // Stack one middleware per capability, THEN the principal gate last.
  // `@effect/rpc` folds the middleware set in insertion order, wrapping the
  // handler each step, so the LAST-attached middleware runs FIRST at request
  // time. The gate (a no-`provides` middleware) folds as
  // `Effect.zipRight(gate, inner)` — attaching it last puts it ahead of every
  // cap obtain, so a wrong-arm caller is rejected BEFORE any cap does its DB
  // work. The `AgentClaimed` refinement carries no middleware (the gate's impl
  // Layer reads it off `requires`), so it does not appear among the caps.
  let gated: ReturnType<typeof member.middleware> | typeof member = member;
  for (const cap of capRequirementsOf(requires)) {
    // `cap.key` is a `MiddlewareRequirementKey` by construction (every
    // `CapabilityRequirement` is registered in `requirementMiddleware`), so the
    // total-map lookup is exhaustive with no cast — a descriptor listing a cap
    // with no registered middleware fails to compile at `capRequirementsOf`.
    gated = gated.middleware(requirementMiddleware[cap.key]);
  }
  return gated.middleware(PrincipalGateMw);
};

/**
 * The middleware-attached server engine group. Each `serverRpcMethods` descriptor
 * maps to an `Rpc.make` whose payload/success/error are the descriptor's Schemas,
 * and — for every tag NOT in {@link UNAUTHENTICATED_METHODS} — carries that
 * method's OWN `*AuthMw`. The runtime `.middleware(...)` call mirrors the
 * type-level {@link EngineRpcFromDef} conditional; the single sound assertion
 * launders `Array.prototype.map`'s homogeneous-return into the per-slot tuple
 * {@link EngineMembers} describes (type-verified by
 * `server-engine-group.types-check.ts`).
 */
// Each descriptor maps to one member via `buildEngineMember`; the per-tag branch
// widens each element to a `gated | unauth` union over distinct per-method
// `*AuthMw` types. `Array.prototype.map` is typed to return a homogeneous element
// array, so TS cannot prove the map preserves the catalog's tuple length NOR that
// each slot took the branch its tag dictates. At runtime it yields exactly one
// member per descriptor in source order, gated with its own `*AuthMw` iff the tag
// is not in `UNAUTHENTICATED_METHODS` — precisely the per-slot tuple
// `EngineMembers` describes. The union-element source does not structurally
// overlap the precise per-slot tuple, so the single sanctioned assertion goes
// through `unknown`; the per-tag tag↔payload↔middleware correlation it claims is
// type-verified by `server-engine-group.types-check.ts`.
type EngineMemberTuple = EngineMembers<typeof serverRpcMethods>;
const rawEngineMembers = serverRpcMethods.map(buildEngineMember);
// eslint-disable-next-line agent-code-guard/as-unknown-as -- tuple-length/keying proof TS cannot express; union-element source does not overlap the precise per-slot tuple, verified by `server-engine-group.types-check.ts`.
const engineMembers = rawEngineMembers as unknown as EngineMemberTuple; // #ignore-sloppy-code[as-unknown-as]: tuple-length/keying proof TS cannot express; verified by server-engine-group.types-check.ts.

export const ServerEngineRpcGroup: RpcGroup.RpcGroup<
  EngineMembers<typeof serverRpcMethods>[number]
> = RpcGroup.make(...engineMembers);

/**
 * One WS-handled engine member. Every catalog method is WS-dispatched, so this
 * is the full {@link ServerEngineRpcGroup} member type; the alias names the
 * member set the engine binds (the type the handler-map canary and the runtime
 * group both describe).
 */
type WsEngineMember = EngineMembers<typeof serverRpcMethods>[number];

/**
 * The group the live server engine binds: every catalog member, each stacked
 * with its `requires` middlewares. Its members map one-to-one onto
 * `serverHandlers`, so `WsServerEngineRpcGroup.toLayer` satisfies `HandlersFrom`.
 * The descriptor↔binding correspondence is compile-checked:
 * `server-engine-group.types-check.ts` pins
 * `RpcGroup.Rpcs&lt;typeof WsServerEngineRpcGroup&gt; ≡ EngineRpcs`, and the TOTAL
 * {@link requirementMiddleware} map makes a requirement with no middleware
 * unrepresentable — so no boot-time gating walk is needed.
 */
export const WsServerEngineRpcGroup: RpcGroup.RpcGroup<WsEngineMember> =
  RpcGroup.make(...engineMembers);
