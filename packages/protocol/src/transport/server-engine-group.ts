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
import type { CallablePrincipal, RpcDefinition } from "./method.js";
import { serverRpcMethods } from "../rpc-registry.js";
import type { JsonRpcMethod } from "./wire.js";
import {
  PrincipalGateMw,
  capMiddlewareByCapKey,
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

type AnyRpcDefinition = RpcDefinition<
  string,
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext
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
  D extends RpcDefinition<
    infer Name,
    infer P,
    infer R,
    CallablePrincipal,
    infer Caps
  >
    ? Name extends UnauthenticatedMethod
      ? Rpc.Rpc<JsonRpcMethod<Name>, P, R, Schema.Schema.AnyNoContext>
      : Rpc.Rpc<
          JsonRpcMethod<Name>,
          P,
          R,
          Schema.Schema.AnyNoContext,
          MwStackFor<Caps>
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
 * Build one engine member from a descriptor: an `Rpc.make` gated with that
 * method's OWN `*AuthMw` (looked up by tag in {@link authMiddlewareByMethod})
 * unless its tag is unauthenticated. The runtime branch matches the type-level
 * conditional in {@link EngineRpcFromDef} by the same `UNAUTHENTICATED_METHODS`
 * predicate plus the same registry lookup; an authenticated tag absent from the
 * registry yields an ungated member, which the partition canary rejects.
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
  if (isUnauthenticatedMethod(definition.name)) {
    return member;
  }
  // Authenticated WS method: stack one middleware per declared cap, THEN the
  // principal gate last. `@effect/rpc` folds the middleware set in insertion
  // order, wrapping the handler each step, so the LAST-attached middleware runs
  // FIRST at request time. The gate (a no-`provides` middleware) folds as
  // `Effect.zipRight(gate, inner)` — it runs before whatever it wraps; attaching
  // it last therefore puts it ahead of every cap obtain, so an unauthenticated
  // or wrong-arm caller is rejected BEFORE any cap does its DB work.
  // A declared cap with no registered middleware is left UNGATED here, which the
  // boot guard `findEngineGatingMismatch` detects: `expectedCapMwKeysByTag`
  // records the cap's own `key` as expected (a placeholder, since no mw key
  // exists), so the built member's middleware set is missing it and the guard
  // fails the boot.
  let gated: ReturnType<typeof member.middleware> | typeof member = member;
  for (const cap of definition.caps) {
    const capMw = capMiddlewareByCapKey[cap.key];
    if (capMw === undefined) {
      continue;
    }
    gated = gated.middleware(capMw);
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
 * The group the live server engine binds: every catalog member, each carrying
 * its own `*AuthMw`. Its members map one-to-one onto `serverHandlers`, so
 * `WsServerEngineRpcGroup.toLayer` satisfies `HandlersFrom`.
 * `server-engine-group.types-check.ts` pins
 * `RpcGroup.Rpcs&lt;typeof WsServerEngineRpcGroup&gt; ≡ EngineRpcs`, and
 * {@link assertWsEngineSize} pins the count at boot.
 */
export const WsServerEngineRpcGroup: RpcGroup.RpcGroup<WsEngineMember> =
  RpcGroup.make(...engineMembers);

/**
 * The number of WS-dispatched engine members — the full catalog
 * (`serverRpcMethods`). The live server's handler map (`serverHandlers`) has
 * exactly this many entries; the boot guard {@link assertWsEngineSize} pins the
 * built group to it.
 */
export const WS_ENGINE_MEMBER_COUNT = serverRpcMethods.length;

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
 * runtime middleware stack violates the partition: an authenticated tag that does
 * not carry the principal gate plus exactly its declared caps' middlewares, or an
 * unauthenticated tag that carries any middleware. `undefined` when every member
 * matches. The boot-time backstop for the gate the `buildEngineMember` stacking
 * cannot prove at the type level — so a regression that drops the gate on a
 * protected method, or stacks the wrong cap mw, is caught at boot rather than
 * shipping a runtime-misgated method.
 */
const ungatedMethods = new Set<string>(UNAUTHENTICATED_METHODS);

/**
 * The cap-mw keys a descriptor's `caps` map to — the EXPECTED middleware set for
 * the method (principal gate + each cap's mw key). A declared cap with NO
 * middleware in {@link capMiddlewareByCapKey} records the cap's OWN `key` as a
 * placeholder expected key; `buildEngineMember` cannot stack a non-existent mw,
 * so the built member is missing that key and {@link findEngineGatingMismatch}
 * fails the boot — catching an under-gated method rather than shipping it.
 */
const expectedCapMwKeysByTag = new Map<string, ReadonlySet<string>>(
  serverRpcMethods.map((definition) => {
    const tag = definition.name as string;
    if (ungatedMethods.has(tag)) {
      return [tag, new Set<string>()] as const;
    }
    const keys = new Set<string>([PrincipalGateMw.key]);
    for (const cap of definition.caps) {
      const capMw = capMiddlewareByCapKey[cap.key];
      keys.add(capMw === undefined ? cap.key : capMw.key);
    }
    return [tag, keys] as const;
  }),
);

/** The partition violation for one built member, or `undefined` when it matches. */
const memberGatingMismatch = (
  tag: string,
  middlewareKeys: ReadonlySet<string>,
): string | undefined => {
  if (ungatedMethods.has(tag)) {
    return middlewareKeys.size > 0
      ? `${tag}: unauthenticated method carries middleware ${[...middlewareKeys].join(", ")}`
      : undefined;
  }
  const expected = expectedCapMwKeysByTag.get(tag);
  if (expected === undefined) {
    return `${tag}: WS-dispatched method absent from the descriptor catalog`;
  }
  const missing = [...expected].filter((k) => !middlewareKeys.has(k));
  const extra = [...middlewareKeys].filter((k) => !expected.has(k));
  if (missing.length > 0 || extra.length > 0) {
    return `${tag}: middleware stack mismatch (missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"})`;
  }
  return undefined;
};

/**
 * One built middleware's string `key` (its `Context.Tag` identifier). The
 * group-member union erases `middlewares`'s element type to `never` at the type
 * level, so this reflects over the runtime set: each entry is a real Tag with a
 * string `key`.
 */
const middlewareKey = (m: unknown): string =>
  (m as { readonly key: string }).key;

export const findEngineGatingMismatch = (): string | undefined => {
  for (const [tag, rpc] of ServerEngineRpcGroup.requests) {
    // Compare by each middleware Tag's `key`, not identity: the group member
    // union narrows `middlewares` to `Set<never>` at the type level, so the
    // runtime Tag's `key` is not type-visible. This walks the BUILT runtime set
    // (each entry is a real `RpcMiddleware` Tag with a string `key`).
    const keys = new Set([...rpc.middlewares].map(middlewareKey));
    const mismatch = memberGatingMismatch(tag, keys);
    if (mismatch !== undefined) {
      return mismatch;
    }
  }
  return undefined;
};
