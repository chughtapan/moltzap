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
 *     `onRequestDecoded` hook
 *   - `ConnectionContext` — transport-state companion of `DecodedRequest`
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
 */
export interface RpcHandler<
  Ctx = unknown,
  D extends AnyRpcDefinition = AnyRpcDefinition,
> {
  readonly definition: D;
  readonly handle: (
    params: ParamsOf<D>,
    ctx: Ctx,
  ) => Effect.Effect<ResultOf<D>, unknown, never>;
}

/**
 * Subscription returned by `register` / `onRequestDecoded`. Idempotent
 * disposal — second `unsubscribe` is a no-op (see "Handler registration
 * contract" in the design doc).
 */
export interface Subscription {
  readonly unsubscribe: Effect.Effect<void, never, never>;
}

/**
 * Decoded form of an inbound request frame surfaced to the
 * `onRequestDecoded` hook. Carries the resolved `definition` so the
 * hook can branch on method identity without re-decoding.
 *
 * `params` is `unknown` here (pre-handler-dispatch): the hook reads
 * decoded raw params; the per-definition `validateParams` runs inside
 * `Connection`'s dispatch path, AFTER the hook returns success.
 */
export interface DecodedRequest {
  readonly id: JsonRpcId;
  readonly method: JsonRpcMethod;
  readonly definition: AnyRpcDefinition;
  readonly params: unknown;
}

/**
 * Transport-state companion of `DecodedRequest`. Carries the underlying
 * `SocketLike` reference plus any transport-specific connection state
 * the hook needs to read (e.g. connection-id, peer metadata). The
 * caller-side definition extends this with auth state — see
 * `socket-handler.ts` for the server seam.
 */
export interface ConnectionContext {
  readonly socket: SocketLike;
}

/**
 * Closed union of error tags `onRequestDecoded` hooks may fail with.
 * Connection serializes the failure to a JSON-RPC error response via
 * `wireErrorFromInstance` and routes the response back to the peer.
 *
 * Open clarification (flagged for impl-staff): the spec's hook
 * signature names `AuthError | RpcServerError`. `AuthError` is
 * caller-defined; in-tree the only caller (server `socket-handler.ts`)
 * raises `UnauthorizedError`, which is already a member of
 * `RegisteredTaggedError`. This alias closes the union over every
 * wire-coded class — the caller's auth error is admissible as long
 * as it registers via `registerErrorClass` (the existing in-tree
 * pattern).
 */
export type HookFailure = RegisteredTaggedError | RpcServerError;
