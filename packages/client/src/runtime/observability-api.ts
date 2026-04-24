/**
 * Public-surface preview for the `MoltZapWsClient` observability API
 * (spec #222). This module declares the new types and the free-function
 * signatures that the implementer ports onto the `MoltZapWsClient` class
 * in the `implement-senior` round. Lives as a standalone interface file
 * so the architect branch can publish typed stubs without editing the
 * existing `ws-client.ts` bodies.
 *
 * Three additions land on `MoltZapWsClient`:
 *
 *   1. `sendRpcTracked` — like `sendRpc` but surfaces the outbound request
 *      id and response envelope `type`. Covers spec §5.1 (B4) + §5.2
 *      (V5). OQ-1 resolution (B).
 *   2. `subscribe(filter, handler)` — per-subscription event delivery with
 *      filter grammar. Covers §5.3 (C4 + `RealClientEventSubscriber.subscribe`
 *      filter stub). OQ-2 / OQ-3 resolutions (A / A). Implementation
 *      lives in `runtime/subscribers.ts`.
 *   3. `onDisconnect: (close: CloseInfo) => void` — required-arg
 *      close-event payload. Covers §5.4 (V7). OQ-5 / OQ-6 resolutions
 *      (A / rewrite-to-migrate).
 *
 * One deletion lands on `MoltZapWsClient`:
 *
 *   - `MoltZapWsClientOptions.onEvent` — deleted. Replaced by
 *     `client.subscribe({}, handler)`. Migration list in design doc
 *     §Consumer migration. OQ-4 resolution (rewrite-to-delete per
 *     team-lead invariant change).
 */
import type { Effect } from "effect";
import type { RpcDefinition, TSchema, Static } from "@moltzap/protocol";
import type {
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "./errors.js";
import type { WsClientLogger } from "../ws-client.js";
import type { CloseInfo } from "./close-info.js";
import type {
  EventSubscription,
  SubscriptionFilter,
  SubscriberHandler,
} from "./subscribers.js";

/**
 * Return shape of `sendRpcTracked`. Spec #222 OQ-1 resolution (B): surface
 * the outbound request `id` (un-vacuates B4 at
 * `packages/protocol/src/testing/conformance/client/rpc-semantics.ts:205-216`)
 * and the response envelope `type` (un-vacuates V5 at
 * `rpc-semantics.ts:103-110`), without leaking `jsonrpc` onto the caller
 * surface.
 *
 * `type` is the literal `"response"` — the only response-frame kind
 * `packages/protocol/src/schema/frames.ts:18` defines — but it is surfaced
 * as an observable value (not a synthesized adapter constant) so the V5
 * predicate can flip under a mutation that forges a non-response shape.
 *
 * `result` is the decoded server payload, identical to what `sendRpc`
 * resolves to today. Errors remain on the typed channel of the Effect.
 */
export interface TrackedRpcResponse<R> {
  readonly id: string;
  readonly type: "response";
  readonly result: R;
}

/**
 * Post-migration shape of `MoltZapWsClient`'s constructor options.
 * Implementer replaces the current `MoltZapWsClientOptions` in
 * `ws-client.ts` with this shape. Diff vs. current:
 *
 *   - DELETED: `onEvent?: (event: EventFrame) => void`. Migration:
 *     `client.subscribe({}, handler)` call post-construction.
 *   - CHANGED: `onDisconnect?: () => void` → `onDisconnect?: (close: CloseInfo) => void`.
 *     Migration: the 3 call sites accept the arg (destructure or ignore).
 *   - UNCHANGED: `serverUrl`, `agentKey`, `onReconnect`, `logger`.
 */
export interface MoltZapWsClientOptionsV2 {
  readonly serverUrl: string;
  readonly agentKey: string;
  /**
   * Called once per disconnect (not reconnect). Spec #222 §5.4 + OQ-5 (A):
   * `close` is the typed close metadata — real WebSocket `{code, reason}`
   * when the transport surfaces them, OQ-5 defaults otherwise. Required
   * arg (OQ-6 rewrite): zero-arg `() => void` callers are migrated to
   * accept (and typically ignore) the arg.
   */
  readonly onDisconnect?: (close: CloseInfo) => void;
  readonly onReconnect?: (helloOk: unknown) => void;
  readonly logger?: WsClientLogger;
}

/**
 * Free-function preview of the method `MoltZapWsClient.sendRpcTracked`.
 * Signature shows both typed-definition and raw-string overloads,
 * mirroring the existing `sendRpc` shape in `ws-client.ts:233-256`.
 *
 * Invariant 3 (spec #222): the returned `id` is the identity minted
 * inside `sendRpcEffect` at `ws-client.ts:552` (`rpc-${++this.requestCounter}`)
 * — no parallel counter, no post-hoc mirror, no second minter.
 *
 * Invariant 5 preserved: errors remain on the typed channel
 * (`NotConnectedError | RpcTimeoutError | RpcServerError`); a resolved
 * tracked response always carries `type: "response"`.
 */
export function sendRpcTracked<
  D extends RpcDefinition<string, TSchema, TSchema>,
>(
  method: D,
  params: Static<D["paramsSchema"]>,
): Effect.Effect<
  TrackedRpcResponse<Static<D["resultSchema"]>>,
  NotConnectedError | RpcTimeoutError | RpcServerError
>;
export function sendRpcTracked(
  method: string,
  params?: unknown,
): Effect.Effect<
  TrackedRpcResponse<unknown>,
  NotConnectedError | RpcTimeoutError | RpcServerError
>;
export function sendRpcTracked(
  method: string | RpcDefinition<string, TSchema, TSchema>,
  params?: unknown,
): Effect.Effect<
  TrackedRpcResponse<unknown>,
  NotConnectedError | RpcTimeoutError | RpcServerError
> {
  void method;
  void params;
  throw new Error("not implemented");
}

/**
 * Free-function preview of the method `MoltZapWsClient.subscribe`.
 *
 * Registers a per-subscription event handler. Delivery starts with the
 * next inbound event (OQ-3 A: unsubscribe-during-dispatch lets the
 * in-flight frame finish; N+1 observes the unsubscribe). Handler
 * receives every event matching the filter in arrival order
 * (Invariant 6).
 *
 * Fails with `NotConnectedError` iff the client has been permanently
 * closed via `close()`. Subscription is legal pre-`connect()`; the
 * registry buffers until the reader fiber starts producing frames.
 *
 * Error channel (Principle 3): the Effect's failure type is the single
 * tagged error `NotConnectedError`; handler-thrown exceptions are
 * caught by the registry and logged via `WsClientLogger.warn`.
 */
export function subscribe(
  filter: SubscriptionFilter,
  handler: SubscriberHandler,
): Effect.Effect<EventSubscription, NotConnectedError> {
  void filter;
  void handler;
  throw new Error("not implemented");
}
