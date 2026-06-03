/**
 * @file Type canary for the handler map (`server-handlers.ts`).
 *
 * The map is the engine's handler bodies for the WS-dispatched methods. These
 * canaries pin two invariants:
 *
 *   1. key totality — the map's keys EXACTLY equal the engine group's
 *      WS-handled member tags (every `ServerEngineRpcGroup` member tag MINUS
 *      the HTTP-only methods, which have no WS handler). A missing handler
 *      drops a required key, a stray key is not a WS member tag.
 *   2. per-tag handler shape + proof exclusion — each handler is assignable to
 *      its member's `Rpc.ToHandlerFn`, and the handler's residual requirement
 *      EXCLUDES that member's `*Auth` proof (the per-method middleware provides
 *      it, so the proof is never a leaked requirement on the bound Layer).
 *
 * `network/connect` is included (its `connect` reads the live arm via
 * `ConnectionTag`, carries no proof); the HTTP-only methods are not.
 */
import type { Rpc, RpcGroup } from "@effect/rpc";
import type { Effect, Schema } from "effect";
import {
  ServerEngineRpcGroup,
  serverRpcMethods,
  type UnauthenticatedMethod,
} from "@moltzap/protocol";
import type {
  JsonRpcMethod,
  ConversationInTask,
  RpcDefinition,
  DomainErrorsOf,
  RequirementErrorsOf,
  ResponseErrorsOf,
  UnauthorizedError,
  ForbiddenError,
} from "@moltzap/protocol";
import { serverHandlers } from "./server-handlers.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

type EngineRpcs = RpcGroup.Rpcs<typeof ServerEngineRpcGroup>;

/**
 * Brand a plain-literal tag union to `JsonRpcMethod&lt;...&gt;` — the engine
 * member tags are branded, so plain operands are branded before comparison.
 */
type AsMethod<Names extends string> = Names extends Names
  ? JsonRpcMethod<Names>
  : never;

// ── 1. key totality ──────────────────────────────────────────────────────

// Every catalog method is WS-dispatched, so the map's key set equals the full
// engine member tag set. The handler keys are plain string literals; brand them
// before comparing against the branded member tags.
type HandlerTags = AsMethod<keyof typeof serverHandlers & string>;
type _KeysCoverWsMembers = Expect<Equal<HandlerTags, EngineRpcs["_tag"]>>;

// `network/connect` is a real key (the unauth WS method).
type _ConnectPresent = Expect<
  [AsMethod<UnauthenticatedMethod>] extends [HandlerTags] ? true : false
>;

// ── 2. per-tag handler shape + proof exclusion ───────────────────────────

type MemberWithTag<Name extends string> = Extract<
  EngineRpcs,
  { readonly _tag: JsonRpcMethod<Name> }
>;

/**
 * The handler's residual requirement after excluding its member's `*Auth`
 * proof — exactly what `ServerEngineRpcGroup.toLayer` puts in the bound Layer's
 * requirement channel for that tag. Reusing the engine's own `ExcludeProvides`
 * keeps the canary in lockstep with how `toLayer` types the binding.
 */
type ResidualOf<Name extends keyof typeof serverHandlers & string> =
  (typeof serverHandlers)[Name] extends (
    ...args: never
  ) => Effect.Effect<infer _A, infer _E, infer R>
    ? Rpc.ExcludeProvides<R, MemberWithTag<Name>, JsonRpcMethod<Name>>
    : never;

// A cap-bearing agent method: `messages/send` stacks the `ConversationInTask`
// cap middleware (among others). Its handler's residual MUST NOT contain
// `ConversationInTask` — the stacked cap middleware provides it. Mirrors
// `server-engine-group.types-check.ts` E.1 at the handler-map level.
type _SendProofExcluded = Expect<
  [ConversationInTask] extends [ResidualOf<"messages/send">] ? false : true
>;

// `network/connect` reads no proof; its handler still type-checks as a
// `ToHandlerFn` for the unauth member (no middleware, no `provides`). The
// `ToHandlerFn` `R` defaults to `any`, so this is a payload/result/error shape
// check, not a requirement check.
type _ConnectHandlerShape = Expect<
  (typeof serverHandlers)["network/connect"] extends Rpc.ToHandlerFn<
    MemberWithTag<"network/connect">
  >
    ? true
    : false
>;

// ── 3. handler error channel ⊆ declared wire-error union ──────────────────
//
// A handler body that fails with a tagged error NOT in its method's declared
// wire-error union cannot be encoded by the engine: the request dies with an
// `ExitEncoded` defect and the wire surfaces a generic `InternalError` instead
// of the intended typed failure. This canary makes that a BUILD failure.
//
// The allowed union is read from the DESCRIPTOR's precise type args, NOT from the
// engine member's error slot — `EngineRpcFromDef` (server-engine-group.ts)
// type-erases that slot to `Schema.AnyNoContext`, so a check keyed on
// `Rpc.Error<member>` is vacuously `E ⊆ any` and catches nothing. Keying on the
// descriptor's `Errs` gives the precise union, so dropping an entry from a
// method's `errors` shrinks the allowed set and the build fails here.
//
// Allowed = the method's declared handler-domain errors (`DomainErrorsOf`) plus
// its CAPABILITY requirements' declared errors (the requirement errors minus the
// principal-gate set — `ConversationInTask` raises `ConversationNotFound`, etc.).
// Two error sets are NOT in the allowed union, by design:
//
//   - The PRINCIPAL-gate errors (`UnauthorizedError | ForbiddenError`, contributed
//     by every authenticated method's `AppPrincipal`/`AgentPrincipal`/`AgentClaimed`
//     requirement). The gate is MIDDLEWARE: it runs before the body and its failures
//     ride its own `failure` arm, never the handler's `E` channel (the arm readers
//     `agentArm`/`appArm` are `never`-failing). Excluding them means a handler-domain
//     `ForbiddenError` (e.g. `assertCallerAppOwnsTask`) MUST be declared in the
//     method's `errors`; reverting that declaration fails the build here even though
//     the gate's incidental `ForbiddenError` arm would still encode it at runtime —
//     `errors` stays the honest, complete handler-domain declaration.
//   - The transport `ResponseErrorsOf` (`NotConnected`/`Timeout`): a client-transport
//     failure, never raised by a handler, but excluded so a future handler that
//     legitimately surfaces it stays sound.

/** The inferred error channel `E` of a handler's `Effect`. */
type HandlerErrorOf<Name extends keyof typeof serverHandlers> =
  (typeof serverHandlers)[Name] extends (
    ...args: never
  ) => Effect.Effect<infer _A, infer E, infer _R>
    ? E
    : never;

/** The principal-gate errors every authenticated method's gate middleware owns. */
type PrincipalGateError = UnauthorizedError | ForbiddenError;

/**
 * The catalog descriptor for one handler tag, with its precise `Errs`/`Requires`
 * type args intact (the `as const` catalog preserves them; `Extract` by `name`
 * picks the one member without widening its args).
 */
type DefForTag<Name extends string> = Extract<
  (typeof serverRpcMethods)[number],
  { readonly name: JsonRpcMethod<Name> }
>;

/**
 * The error instances a method's handler is ALLOWED to raise: the descriptor's
 * declared handler-domain errors, its capability requirements' declared errors
 * (the requirement errors MINUS the principal-gate set, which the gate middleware
 * owns), plus the always-allowed transport set. The `any` in the `Requires` slot
 * only re-infers each member's own tuple — `DomainErrorsOf` still reads the
 * descriptor's precise `Errs`.
 */
type DeclaredErrorsOf<Name extends string> =
  DefForTag<Name> extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    infer Requires,
    any
  >
    ?
        | DomainErrorsOf<DefForTag<Name>>
        | Exclude<RequirementErrorsOf<Requires>, PrincipalGateError>
        | ResponseErrorsOf
    : never;

/**
 * Per-tag residual: the handler errors NOT in the method's allowed union. A
 * sound handler has an empty (`never`) residual for every WS tag.
 */
type UndeclaredHandlerError<Name extends keyof typeof serverHandlers & string> =
  Exclude<HandlerErrorOf<Name>, DeclaredErrorsOf<Name>>;

/**
 * Driven over EVERY handler tag, so a new handler (or a reverted `errors`
 * union) that raises an undeclared error fails the build here, not at runtime.
 */
type _NoUndeclaredHandlerErrors = Expect<
  Equal<
    {
      readonly [Name in keyof typeof serverHandlers &
        string]: UndeclaredHandlerError<Name>;
    }[keyof typeof serverHandlers & string],
    never
  >
>;

export type {
  _KeysCoverWsMembers,
  _ConnectPresent,
  _SendProofExcluded,
  _ConnectHandlerShape,
  _NoUndeclaredHandlerErrors,
};
