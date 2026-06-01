/**
 * @file The server engine's middleware-attached `RpcGroup` and the
 * unauthenticated-method allowlist that partitions it.
 *
 * `ServerEngineRpcGroup` is the group {@link native-server-engine.ServerEngineLayer}
 * binds: every member EXCEPT those in {@link UNAUTHENTICATED_METHODS} carries the
 * {@link PrincipalResolution} middleware (the #720 principal-kind gate +
 * `CurrentPrincipal`). It is distinct from the catalog-derived
 * {@link rpc-method-groups.ServerRpcGroup}, which stays un-gated and is used for
 * client typing + the per-tag canary; binding `ServerRpcGroup` in server wiring
 * would run every method with no gate — an authorization bypass.
 *
 * The partition is total and compiler-checked
 * (`server-engine-group.types-check.ts`): every `ServerRpcGroup` tag is in
 * exactly one partition (gated XOR unauth-allowlisted), so a new authenticated
 * method that forgets the gate is in neither and fails the build.
 *
 * The group is catalog-derived (`serverRpcMethods`), which is a SUPERSET of the
 * methods the WS server engine actually handles: `serverRpcMethods` also carries
 * the HTTP-only `agents/register`, `agents/claim`, `agents/invite`, and
 * `invites/createAgent` methods, served over `http-routes.ts` with no WS handler
 * slot. The server's single-source binding registry (the WS surface) is the
 * subset that gets handler bodies; its `principalKinds` policy table is
 * validated at boot against this group's gated members (every binding tag is a
 * group member). Binding the engine's `toLayer` handler map is over the WS
 * subset.
 */
import { Rpc, RpcGroup, RpcMiddleware } from "@effect/rpc";
import type { Schema } from "effect";
import { CurrentPrincipal } from "./current-principal.js";
import type { RpcDefinition } from "./method.js";
import { serverRpcMethods } from "../rpc-registry.js";
import { WireErrorSchema } from "./rpc-method-groups.js";
import type { JsonRpcMethod } from "./wire.js";

/**
 * The `@effect/rpc` middleware descriptor that provides the request's
 * authenticated {@link CurrentPrincipal.Principal} into every gated handler's
 * Context. `provides: CurrentPrincipal` makes the middleware's service value
 * the 2-arm principal, so a handler reads identity via `yield* CurrentPrincipal`
 * with no `ctx` parameter and no cast.
 *
 * The descriptor is protocol-owned because the Tag it provides
 * (`CurrentPrincipal`) is protocol-owned; the implementation that resolves a
 * connection to its live arm (via the server's `ConnectionManager`) and narrows
 * the 3-arm connection union to the 2-arm principal is a server concern,
 * supplied as a per-socket `Layer` over this Tag. The middleware impl shape
 * `@effect/rpc` derives from this descriptor is
 * `({ clientId, rpc, payload, headers }) => Effect&lt;Principal, WireError&gt;` —
 * payload-only, no `ctx`.
 *
 * `failure: WireErrorSchema` types the gate's rejection as the same coded wire
 * envelope every member's `error` carries, so a wrong-principal/inactive frame
 * fails the middleware effect with a typed `WireError` the client reconstructs
 * via `wire-errors.ts → errorClassFor`. Non-optional (no `optional: true`): an
 * optional middleware's runtime fold falls through to the handler on failure,
 * which would let a rejected principal reach the body — the gate must HARD-fail.
 */
export class PrincipalResolution extends RpcMiddleware.Tag<PrincipalResolution>()(
  "@moltzap/protocol/PrincipalResolution",
  { provides: CurrentPrincipal, failure: WireErrorSchema },
) {}

/**
 * The ONLY methods callable on an unauthenticated connection. Built WITHOUT
 * {@link PrincipalResolution} (no principal exists pre-auth); they read the live
 * 3-arm `Connection` via `ConnectionTag`. EXHAUSTIVE: every other
 * `ServerRpcGroup` method is authenticated and carries the gate. Adding a method
 * here is a deliberate, reviewed security decision — the partition canary
 * (`server-engine-group.types-check.ts`) FAILS the build if a method is in
 * neither partition or both.
 */
export const UNAUTHENTICATED_METHODS = ["network/connect"] as const;

/** A plain (unbranded) member of {@link UNAUTHENTICATED_METHODS}. */
export type UnauthenticatedMethod = (typeof UNAUTHENTICATED_METHODS)[number];

type AnyRpcDefinition = RpcDefinition<
  string,
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext
>;

/**
 * The engine member a single descriptor maps to: its branded wire `name` is the
 * member tag, `paramsSchema`/`resultSchema` are payload/success verbatim, the
 * shared {@link WireErrorSchema} envelope is the error Schema, and the 5th
 * (`Middleware`) param is {@link PrincipalResolution} unless the tag is in
 * {@link UNAUTHENTICATED_METHODS} (then `never` — no gate). The per-tag
 * conditional is what makes the partition type-level.
 */
type EngineRpcFromDef<D> =
  D extends RpcDefinition<infer Name, infer P, infer R>
    ? Name extends UnauthenticatedMethod
      ? Rpc.Rpc<JsonRpcMethod<Name>, P, R, typeof WireErrorSchema>
      : Rpc.Rpc<
          JsonRpcMethod<Name>,
          P,
          R,
          typeof WireErrorSchema,
          typeof PrincipalResolution
        >
    : never;

/**
 * The per-member tuple the server catalog maps to, homomorphic over its
 * `as const` tuple so each member keeps its own tag/payload/success/middleware
 * types per slot. Same shape {@link rpc-method-groups.GroupMembers} uses, with
 * the per-tag {@link PrincipalResolution} attachment folded in.
 */
type EngineMembers<Defs extends readonly AnyRpcDefinition[]> = {
  readonly [K in keyof Defs]: EngineRpcFromDef<Defs[K]>;
};

const isUnauthenticated = (name: string): boolean =>
  (UNAUTHENTICATED_METHODS as readonly string[]).includes(name);

/**
 * Build one engine member from a descriptor: an `Rpc.make` gated with
 * {@link PrincipalResolution} unless its tag is unauthenticated. The runtime
 * branch matches the type-level conditional in {@link EngineRpcFromDef} by the
 * same `UNAUTHENTICATED_METHODS` predicate.
 */
const buildEngineMember = (definition: AnyRpcDefinition) => {
  const member = Rpc.make(definition.name, {
    payload: definition.paramsSchema,
    success: definition.resultSchema,
    error: WireErrorSchema,
  });
  return isUnauthenticated(definition.name)
    ? member
    : member.middleware(PrincipalResolution);
};

/**
 * The middleware-attached server engine group. Each `serverRpcMethods`
 * descriptor maps to an `Rpc.make` whose payload/success/error are the
 * descriptor's Schemas, and — for every tag NOT in
 * {@link UNAUTHENTICATED_METHODS} — carries {@link PrincipalResolution}. The
 * runtime `.middleware(...)` call mirrors the type-level
 * {@link EngineRpcFromDef} conditional; the single sound assertion launders
 * `Array.prototype.map`'s homogeneous-return into the per-slot tuple
 * {@link EngineMembers} describes, the SAME laundering
 * {@link rpc-method-groups.groupFromCatalog} uses (type-verified by
 * `server-engine-group.types-check.ts`).
 */
// Each descriptor maps to one member via `buildEngineMember`; the per-tag branch
// widens each element to a `gated | unauth` union. `Array.prototype.map` is typed
// to return a homogeneous element array, so TS cannot prove the map preserves the
// catalog's tuple length NOR that each slot took the branch its tag dictates. At
// runtime it yields exactly one member per descriptor in source order, gated iff
// the tag is not in `UNAUTHENTICATED_METHODS` — precisely the per-slot tuple
// `EngineMembers` describes. The union-element source does not structurally
// overlap the precise per-slot tuple, so the single sanctioned assertion (the
// same tuple-length/keying proof `groupFromCatalog` cannot express either) goes
// through `unknown`; the per-tag tag↔payload↔middleware correlation it claims is
// type-verified by `server-engine-group.types-check.ts`.
type EngineMemberTuple = EngineMembers<typeof serverRpcMethods>;
const rawEngineMembers = serverRpcMethods.map(buildEngineMember);
// eslint-disable-next-line agent-code-guard/as-unknown-as -- tuple-length/keying proof TS cannot express; union-element source does not overlap the precise per-slot tuple, the same single assertion `groupFromCatalog` uses, verified by `server-engine-group.types-check.ts`.
const engineMembers = rawEngineMembers as unknown as EngineMemberTuple; // #ignore-sloppy-code[as-unknown-as]: tuple-length/keying proof TS cannot express; verified by server-engine-group.types-check.ts.

export const ServerEngineRpcGroup: RpcGroup.RpcGroup<
  EngineMembers<typeof serverRpcMethods>[number]
> = RpcGroup.make(...engineMembers);
