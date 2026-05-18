/**
 * @file `queuedHandler` — bounded-capacity wrapper around an `RpcHandler`.
 *
 * STUB FILE — architect tier, Spec A (#595), arch sub-issue #603.
 *
 * Spec A Decision D1 — backpressure lives outside `Connection` as a
 * sibling utility. Callers explicitly opt in by wrapping their handler:
 *
 *   `connection.register(def, queuedHandler(myHandler, { capacity: 8192, onFull: rejectWithBusy }))`
 *
 * Default `register` dispatches inline (no queue). Queued dispatch
 * requires this wrapper.
 */
import { Data, Effect } from "effect";
import type { TSchema } from "@sinclair/typebox";
import type { RpcDefinition } from "../method.js";
import type { RpcHandler } from "./handler.js";

type AnyRpcDefinition = RpcDefinition<string, TSchema, TSchema>;

/**
 * Backpressure policy when `queuedHandler`'s bounded queue is full.
 *
 * - `RejectWithBusy` — reply with a JSON-RPC `QueueFull` (code -32099)
 *   error response immediately. Spec A "Golden frames" §9 fixes the
 *   wire shape.
 * - `Drop` — silently drop the frame. The remote's `Deferred.await`
 *   on a request will time out at the caller's deadline.
 */
export type OnFullPolicy =
  | { readonly _tag: "RejectWithBusy" }
  | { readonly _tag: "Drop" };

/** Pre-baked `RejectWithBusy` policy. */
export const rejectWithBusy: OnFullPolicy = { _tag: "RejectWithBusy" };

/** Pre-baked `Drop` policy. */
export const dropOnFull: OnFullPolicy = { _tag: "Drop" };

/** Configuration for `queuedHandler`. */
export interface QueuedHandlerOptions {
  readonly capacity: number;
  readonly onFull: OnFullPolicy;
}

/**
 * Wrap an inline `RpcHandler` in a bounded queue. The returned handler
 * is shape-compatible with `RpcHandler` and may be passed to
 * `Connection.register(def, queuedHandler(handler, opts))` directly.
 *
 * Implementation hint (impl-staff): the wrapper allocates an
 * `Effect.Queue.bounded&lt;…>` keyed per `def.name`, forks a drainer
 * fiber at first dispatch, and routes `onFull` rejections back through
 * Connection's writer.
 */
export function queuedHandler<Ctx, D extends AnyRpcDefinition>(
  inner: RpcHandler<Ctx, D>,
  _options: QueuedHandlerOptions,
): RpcHandler<Ctx, D> {
  // Stub: returns a shape-compatible `RpcHandler` whose `handle` dies
  // via `Effect.dieMessage` when invoked. Uniform with
  // `makeServerConnection` / `makeClientConnection` — every Connection-
  // facade stub dies via Effect, never via a synchronous throw (codex
  // r1 F9 — stub convention drift). Impl-staff replaces this body with
  // the bounded-queue wrapper.
  return {
    definition: inner.definition,
    handle: () =>
      Effect.dieMessage(
        "queuedHandler stub — not implemented yet (Spec A #595 / arch sub-issue #603)",
      ),
  };
}

/**
 * Tagged error raised by the wrapper's drainer when capacity is
 * exceeded under `rejectWithBusy`. Exported so callers may
 * `Effect.catchTag("QueueFull", ...)` for instrumentation; not
 * intended for direct construction.
 */
export class QueueFullError extends Data.TaggedError("QueueFull")<{
  readonly method: string;
  readonly capacity: number;
}> {}
