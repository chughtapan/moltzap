/**
 * @file The server engine's middleware-attached `RpcGroup` and the
 * unauthenticated-method allowlist that partitions it.
 *
 * `ServerEngineRpcGroup` is the group {@link native-server-engine.ServerEngineLayer}
 * binds: every member EXCEPT those in {@link UNAUTHENTICATED_METHODS} carries that
 * method's OWN `*AuthMw` middleware (the per-method principal-kind gate + caps,
 * `auth-middleware.ts`), looked up by tag in {@link authMiddlewareByMethod}. It is
 * distinct from the catalog-derived {@link rpc-method-groups.ServerRpcGroup}, which
 * stays un-gated and is used for client typing + the per-tag canary; binding
 * `ServerRpcGroup` in server wiring would run every method with no gate — an
 * authorization bypass.
 *
 * The partition is total and compiler-checked
 * (`server-engine-group.types-check.ts`): every `ServerRpcGroup` tag is in exactly
 * one partition (carries its `*AuthMw` XOR is unauth-allowlisted), so a new
 * authenticated method that forgets its `*AuthMw` registry entry is in neither and
 * fails the build.
 *
 * The group is catalog-derived (`serverRpcMethods`), which is a SUPERSET of the
 * methods the WS server engine actually handles: `serverRpcMethods` also carries
 * the HTTP-only `agents/register`, `agents/claim`, `agents/invite`, and
 * `invites/createAgent` methods, served over `http-routes.ts` with no WS handler
 * slot. The server's single-source binding registry (the WS surface) is the
 * subset that gets handler bodies; its `principalKinds` policy table is validated
 * at boot against this group's gated members (every binding tag is a group
 * member). Binding the engine's `toLayer` handler map is over the WS subset.
 */
import { Rpc, RpcGroup, RpcMiddleware } from "@effect/rpc";
import type { Schema } from "effect";
import type { RpcDefinition } from "./method.js";
import { serverRpcMethods } from "../rpc-registry.js";
import { WireErrorSchema } from "./rpc-method-groups.js";
import type { JsonRpcMethod } from "./wire.js";
import {
  authMiddlewareByMethod,
  type AuthMiddlewareByMethod,
} from "./auth-middleware.js";

/**
 * The ONLY methods callable on an unauthenticated connection. Built WITHOUT any
 * `*AuthMw` (no principal exists pre-auth); they read the live 3-arm `Connection`
 * via `ConnectionTag`. EXHAUSTIVE: every other `ServerRpcGroup` method is
 * authenticated and carries its `*AuthMw`. Adding a method here is a deliberate,
 * reviewed security decision — the partition canary
 * (`server-engine-group.types-check.ts`) FAILS the build if a method is in
 * neither partition or both.
 */
export const UNAUTHENTICATED_METHODS = ["network/connect"] as const;

/** A plain (unbranded) member of {@link UNAUTHENTICATED_METHODS}. */
export type UnauthenticatedMethod = (typeof UNAUTHENTICATED_METHODS)[number];

/**
 * The catalog methods served ONLY over `http-routes.ts`, never WS-dispatched.
 * They are `serverRpcMethods` members (so they appear in the catalog-derived
 * group) but have no WS handler slot and no `*AuthMw`: HTTP requests carry their
 * own bearer/registration credentials, gated in `http-routes.ts`, not by the WS
 * engine's per-method middleware. The third partition arm alongside the
 * `*AuthMw`-gated WS methods and {@link UNAUTHENTICATED_METHODS}; the partition
 * canary (`server-engine-group.types-check.ts`) pins that these three arms
 * exactly cover the catalog.
 */
const HTTP_ONLY_METHODS = [
  "agents/register",
  "agents/claim",
  "agents/invite",
  "invites/createAgent",
] as const;

/** A plain (unbranded) member of {@link HTTP_ONLY_METHODS}. */
export type HttpOnlyMethod = (typeof HTTP_ONLY_METHODS)[number];

/**
 * Whether a wire tag is in {@link UNAUTHENTICATED_METHODS} — the single
 * membership check both the engine-group construction (which omits the gate
 * for these) and the server's `principalKinds` projection (which omits them
 * from the policy table) share, so the two agree on the partition by
 * construction.
 */
export const isUnauthenticatedMethod = (tag: string): boolean =>
  (UNAUTHENTICATED_METHODS as readonly string[]).includes(tag);

type AnyRpcDefinition = RpcDefinition<
  string,
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext
>;

/**
 * The engine member a single descriptor maps to: its branded wire `name` is the
 * member tag, `paramsSchema`/`resultSchema` are payload/success verbatim, the
 * shared {@link WireErrorSchema} envelope is the error Schema, and the 5th
 * (`Middleware`) param is that method's OWN `*AuthMw` (looked up in
 * {@link AuthMiddlewareByMethod} by the tag). An unauthenticated method
 * ({@link UNAUTHENTICATED_METHODS}) and an HTTP-only method
 * ({@link HTTP_ONLY_METHODS}, no WS handler) carry no middleware. The per-tag
 * conditional makes the partition type-level: any other tag (authenticated WS
 * method) resolves via the registry, so a method that forgets its `*AuthMw`
 * registry entry is unmatched there and the partition canary fails.
 */
type EngineRpcFromDef<D> =
  D extends RpcDefinition<infer Name, infer P, infer R>
    ? Name extends UnauthenticatedMethod | HttpOnlyMethod
      ? Rpc.Rpc<JsonRpcMethod<Name>, P, R, typeof WireErrorSchema>
      : Name extends keyof AuthMiddlewareByMethod
        ? Rpc.Rpc<
            JsonRpcMethod<Name>,
            P,
            R,
            typeof WireErrorSchema,
            AuthMiddlewareByMethod[Name]
          >
        : never
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
 * Build one engine member from a descriptor: an `Rpc.make` gated with that
 * method's OWN `*AuthMw` (looked up by tag in {@link authMiddlewareByMethod})
 * unless its tag is unauthenticated. The runtime branch matches the type-level
 * conditional in {@link EngineRpcFromDef} by the same `UNAUTHENTICATED_METHODS`
 * predicate plus the same registry lookup; an authenticated tag absent from the
 * registry yields an ungated member, which the partition canary rejects.
 */
const buildEngineMember = (definition: AnyRpcDefinition) => {
  const member = Rpc.make(definition.name, {
    payload: definition.paramsSchema,
    success: definition.resultSchema,
    error: WireErrorSchema,
  });
  if (isUnauthenticatedMethod(definition.name)) {
    return member;
  }
  const mw = (
    authMiddlewareByMethod as Record<
      string,
      RpcMiddleware.TagClassAny | undefined
    >
  )[definition.name];
  return mw === undefined ? member : member.middleware(mw);
};

/**
 * The middleware-attached server engine group. Each `serverRpcMethods` descriptor
 * maps to an `Rpc.make` whose payload/success/error are the descriptor's Schemas,
 * and — for every tag NOT in {@link UNAUTHENTICATED_METHODS} — carries that
 * method's OWN `*AuthMw`. The runtime `.middleware(...)` call mirrors the
 * type-level {@link EngineRpcFromDef} conditional; the single sound assertion
 * launders `Array.prototype.map`'s homogeneous-return into the per-slot tuple
 * {@link EngineMembers} describes, the SAME laundering
 * {@link rpc-method-groups.groupFromCatalog} uses (type-verified by
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
// overlap the precise per-slot tuple, so the single sanctioned assertion (the same
// tuple-length/keying proof `groupFromCatalog` cannot express either) goes through
// `unknown`; the per-tag tag↔payload↔middleware correlation it claims is
// type-verified by `server-engine-group.types-check.ts`.
type EngineMemberTuple = EngineMembers<typeof serverRpcMethods>;
const rawEngineMembers = serverRpcMethods.map(buildEngineMember);
// eslint-disable-next-line agent-code-guard/as-unknown-as -- tuple-length/keying proof TS cannot express; union-element source does not overlap the precise per-slot tuple, the same single assertion `groupFromCatalog` uses, verified by `server-engine-group.types-check.ts`.
const engineMembers = rawEngineMembers as unknown as EngineMemberTuple; // #ignore-sloppy-code[as-unknown-as]: tuple-length/keying proof TS cannot express; verified by server-engine-group.types-check.ts.

export const ServerEngineRpcGroup: RpcGroup.RpcGroup<
  EngineMembers<typeof serverRpcMethods>[number]
> = RpcGroup.make(...engineMembers);

/**
 * Whether a wire tag is HTTP-only ({@link HTTP_ONLY_METHODS}) — the membership
 * check the WS-subset group construction shares with the partition, so the two
 * agree on which methods the WS engine omits.
 */
const isHttpOnlyMethod = (tag: string): boolean =>
  (HTTP_ONLY_METHODS as readonly string[]).includes(tag);

/**
 * One WS-handled engine member: every {@link ServerEngineRpcGroup} member whose
 * tag is NOT HTTP-only. `network/connect` (an unauthenticated WS method) stays.
 * The type mirrors `native-handlers.types-check.ts → WsEngineRpcs`, so the
 * runtime subset and the handler-map canary describe the same member set.
 */
type WsEngineMember = Exclude<
  EngineMembers<typeof serverRpcMethods>[number],
  { readonly _tag: JsonRpcMethod<HttpOnlyMethod> }
>;

/**
 * The WS-dispatched subset of {@link ServerEngineRpcGroup}: the catalog group
 * minus the four {@link HTTP_ONLY_METHODS} (served over `http-routes.ts`, no WS
 * handler). The live server engine binds this group — its members map
 * one-to-one onto `serverNativeHandlers`, so `WsServerEngineRpcGroup.toLayer`
 * satisfies `HandlersFrom` (the full 31-member group would demand handlers for
 * the four HTTP-only methods that have none). Each surviving member keeps its
 * own `*AuthMw`, so the per-method gate rides the WS engine unchanged.
 *
 * The launder mirrors {@link ServerEngineRpcGroup}'s: `Array.prototype.filter`
 * is typed to return the wide element union, so TS cannot prove the filtered
 * array is exactly the {@link WsEngineMember} tuple. The runtime predicate keeps
 * exactly the non-HTTP-only members; the type-level `Exclude` keeps exactly the
 * same set. `server-engine-group.types-check.ts` pins
 * `RpcGroup.Rpcs&lt;typeof WsServerEngineRpcGroup&gt; ≡ WsEngineRpcs`, and
 * {@link assertWsEngineSize} pins the count at boot, so a predicate that drifts
 * from the `Exclude` fails the build or the boot guard.
 */
const wsEngineMembers = engineMembers.filter(
  (member) => !isHttpOnlyMethod(member._tag),
);
const wsEngineMemberTuple =
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- filter's element-union return cannot prove the precise WS-member tuple; the runtime predicate and the type-level Exclude keep the same set, pinned by server-engine-group.types-check.ts + assertWsEngineSize.
  wsEngineMembers as unknown as readonly WsEngineMember[]; // #ignore-sloppy-code[as-unknown-as]: filter cannot prove the WS-member tuple; verified by server-engine-group.types-check.ts + the boot guard.

export const WsServerEngineRpcGroup: RpcGroup.RpcGroup<WsEngineMember> =
  RpcGroup.make(...wsEngineMemberTuple);

/**
 * The number of WS-dispatched engine members: the full catalog
 * (`serverRpcMethods`) minus the four {@link HTTP_ONLY_METHODS}. The live
 * server's handler map (`serverNativeHandlers`) has exactly this many entries;
 * the boot guard {@link assertWsEngineSize} pins the built group to it.
 */
export const WS_ENGINE_MEMBER_COUNT =
  serverRpcMethods.length - HTTP_ONLY_METHODS.length;

/**
 * Boot-time backstop pinning {@link WsServerEngineRpcGroup}'s member count to
 * {@link WS_ENGINE_MEMBER_COUNT}. The type-level canary pins the member SET; this
 * inspects the ACTUAL built `.requests` map, so a filter regression that drops or
 * duplicates a member is caught at boot rather than shipping a misbound engine.
 * Returns the violation string, or `undefined` when the count matches.
 */
export const assertWsEngineSize = (): string | undefined => {
  const size = WsServerEngineRpcGroup.requests.size;
  return size === WS_ENGINE_MEMBER_COUNT
    ? undefined
    : `WsServerEngineRpcGroup has ${size} members, expected ${WS_ENGINE_MEMBER_COUNT}`;
};

/**
 * Walk the BUILT {@link ServerEngineRpcGroup} members and return the first whose
 * runtime middleware violates the partition: an authenticated tag that does not
 * carry its OWN `*AuthMw` (the registry entry's `key`), or an unauthenticated tag
 * that carries any middleware. `undefined` when every member matches. The
 * boot-time backstop for the partition the group construction's single type
 * assertion cannot prove — the type-level canary pins the asserted SHAPE; this
 * inspects the ACTUAL runtime middleware, so a `buildEngineMember` regression that
 * drops the gate on a protected method (or attaches the wrong method's `*AuthMw`)
 * is caught at boot rather than shipping a runtime-misgated method the assertion
 * still types as gated.
 */
const expectedAuthMwKeyByTag = new Map<string, string>(
  Object.entries(authMiddlewareByMethod).map(([tag, mw]) => [tag, mw.key]),
);
const ungatedMethods = new Set<string>([
  ...UNAUTHENTICATED_METHODS,
  ...HTTP_ONLY_METHODS,
]);

/** The partition violation for one built member, or `undefined` when it matches. */
const memberGatingMismatch = (
  tag: string,
  middlewareKeys: ReadonlySet<string>,
): string | undefined => {
  if (ungatedMethods.has(tag)) {
    return middlewareKeys.size > 0
      ? `${tag}: ungated method (unauth or HTTP-only) carries middleware ${[...middlewareKeys].join(", ")}`
      : undefined;
  }
  const expectedKey = expectedAuthMwKeyByTag.get(tag);
  if (expectedKey === undefined) {
    return `${tag}: WS-dispatched method has no *AuthMw registry entry`;
  }
  return middlewareKeys.has(expectedKey)
    ? undefined
    : `${tag}: missing its *AuthMw (expected ${expectedKey}, carries ${[...middlewareKeys].join(", ") || "none"})`;
};

export const findEngineGatingMismatch = (): string | undefined => {
  for (const [tag, rpc] of ServerEngineRpcGroup.requests) {
    // Compare by the middleware Tag's `key`, not identity: the union member type
    // narrows `middlewares` to `Set<never>`, so `.has(mw)` does not type-check.
    // The runtime `key` match is exact (each set carries its method's `*AuthMw`
    // Tag, whose `key` is its identifier).
    const keys = new Set([...rpc.middlewares].map((m) => m.key));
    const mismatch = memberGatingMismatch(tag, keys);
    if (mismatch !== undefined) {
      return mismatch;
    }
  }
  return undefined;
};
