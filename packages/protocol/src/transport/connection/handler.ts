/**
 * @file Handler-registration surface for Connection.
 *
 * STUB FILE — architect tier, Spec A (#595), arch sub-issue #603.
 *
 * Defines the post-refactor shapes:
 *   - `RpcHandler&lt;Ctx, D>` — definition-typed handler (replaces the
 *     legacy `RpcHandler&lt;Ctx, R>` from `../json-rpc-server.ts`,
 *     which deletes during impl-staff cutover)
 *   - `Subscription` — handle for registration disposal
 *   - `DecodedRequest` — pre-dispatch decoded shape exposed to the
 *     `onRequestDecoded` hook (`params` is post-JSON-parse
 *     pre-`validateParams`; typed `JsonValue`, never `unknown`)
 *   - `ConnectionContext&lt;Ctx>` — transport seam intersected with the
 *     caller's context type, so hooks read both `socket` AND the
 *     handler-thread `Ctx` (e.g. `connId`, `auth`) without out-of-band
 *     closure tricks
 *   - `JsonValue` — closed boundary type for opaque wire payloads
 *     (replaces `unknown` per PRINCIPLES no-`unknown`-at-boundaries)
 */
import type { Effect } from "effect";
import type { TSchema } from "@sinclair/typebox";
import type { ParamsOf, ResultOf, RpcDefinition } from "../method.js";
import type { JsonRpcId, JsonRpcMethod } from "../wire.js";
import type { SocketLike } from "./socket-like.js";
import type { RegisteredTaggedError } from "../../rpc-registry.js";
import type { RpcServerError } from "../rpc-errors.js";

type AnyRpcDefinition = RpcDefinition<string, TSchema, TSchema>;

/**
 * Closed boundary type for opaque wire-shaped payloads — output of
 * `JSON.parse`, input to schema validators, payload-of-payload for
 * JSON-RPC error `data` fields. Replaces every `unknown` that crossed
 * the Connection public surface in earlier drafts.
 *
 * Recursion bottoms at primitives + null; the structural forms
 * (array, object) recurse so a deeply nested wire payload still types
 * cleanly. The Connection's decoder is the type-narrowing seam: AFTER
 * `def.validateParams(params)` the value narrows from `JsonValue` to
 * `ParamsOf&lt;D>`; BEFORE validation, every consumer sees `JsonValue`.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Definition-typed handler. The handler's `definition` field anchors
 * the generic so `params: ParamsOf&lt;D>` and the result `ResultOf&lt;D>`
 * are statically inferred.
 *
 * Replaces `RpcHandler&lt;Ctx, R>` from `../json-rpc-server.ts`. The
 * generic position previously named `R` (Effect requirements) is now
 * `D` (definition) — impl-staff migrates the call sites at cutover.
 *
 * Effect requirement channel is fixed to `never` to keep the handler
 * portable across server / client / test driver contexts. Callers
 * provide R via `Effect.provide(...)` at the registration site
 * (`Connection.register(def, queuedHandler(provideR(handler), opts))`).
 *
 * Error channel is `HookFailure | RpcServerError` (closed wire-coded
 * union) — replaces the legacy `unknown` from `json-rpc-server.ts`.
 * Handler-side defects (untagged crashes) surface via Effect's defect
 * channel (`Cause.die`), NOT the error channel; Connection's
 * dispatcher catches defects and emits an `InternalError` wire
 * response (existing semantics from `json-rpc-server.ts → failureResponse`).
 */
export interface RpcHandler<
  Ctx = unknown,
  D extends AnyRpcDefinition = AnyRpcDefinition,
> {
  readonly definition: D;
  readonly handle: (
    params: ParamsOf<D>,
    ctx: Ctx,
  ) => Effect.Effect<ResultOf<D>, HookFailure, never>;
}

/**
 * Subscription returned by `register` / `onRequestDecoded`. Idempotent
 * disposal — second `unsubscribe` is a no-op (see "Handler registration
 * invariants" in the design doc).
 */
export interface Subscription {
  readonly unsubscribe: Effect.Effect<void, never, never>;
}

/**
 * Decoded form of an inbound request frame surfaced to the
 * `onRequestDecoded` hook. Carries the resolved `definition` so the
 * hook can branch on method identity without re-decoding.
 *
 * `params: JsonValue` is post-`JSON.parse` AND post-`decodeFrame`
 * (the wire-shape pass), but PRE per-definition `validateParams`.
 * Connection's dispatcher runs `def.validateParams` AFTER the hook
 * chain succeeds; only then does the value narrow to `ParamsOf&lt;D>`.
 */
export interface DecodedRequest {
  readonly id: JsonRpcId;
  readonly method: JsonRpcMethod;
  readonly definition: AnyRpcDefinition;
  readonly params: JsonValue;
}

/**
 * Hook + handler context. Intersects the handler-thread `Ctx`
 * (server: `DispatchContext` with `auth` + `connId`; client:
 * `ServerRpcContext` with `requestId` + `definition`) with the
 * transport seam (`socket`). Resolves codex's "auth hook can't reach
 * connId" concern: every member of the caller's `Ctx` is structurally
 * visible to the hook AND to handlers.
 *
 * Implementation hint (impl-staff): Connection constructs the runtime
 * value once per inbound frame as
 * `{ ...userCtx, socket }` and passes it to both the hook chain and
 * `RpcHandler.handle`.
 */
export type ConnectionContext<Ctx = unknown> = Ctx & {
  readonly socket: SocketLike;
};

/**
 * Closed union of error tags `onRequestDecoded` hooks may fail with.
 * Connection serializes the failure to a JSON-RPC error response via
 * `wireErrorFromInstance` and routes the response back to the peer.
 *
 * The spec's hook signature names `AuthError | RpcServerError`.
 * `AuthError` is caller-defined; in-tree the only caller (server
 * `socket-handler.ts`) raises `UnauthorizedError`, which is already a
 * member of `RegisteredTaggedError`. This alias closes the union over
 * every wire-coded class — caller auth errors are admissible iff they
 * register via `registerErrorClass` (the existing in-tree pattern).
 *
 * Architect decision (resolves §9 clarification): this is the final
 * shape. Callers extending `HookFailure` must registerErrorClass; no
 * `unknown` escape hatch.
 */
export type HookFailure = RegisteredTaggedError | RpcServerError;
