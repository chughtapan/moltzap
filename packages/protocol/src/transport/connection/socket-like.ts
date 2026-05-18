/**
 * @file `SocketLike` — the transport seam Connection accepts.
 *
 * STUB FILE — architect tier, Spec A (#595), arch sub-issue #603.
 *
 * Spec A Assumption 2: "The `SocketLike` abstraction Connection accepts
 * is structurally compatible with `@effect/platform/Socket.Socket` —
 * concretely the contract is `{ write, runRaw }`. Connection translates
 * `@effect/platform/Socket.SocketError` to its own `SocketWriteError` /
 * `SocketReadError` / `ConnectionClosedError` tagged errors at the
 * boundary."
 */
import type { Effect } from "effect";
import type { SocketReadError, SocketWriteError } from "../errors.js";

/**
 * Structural transport contract. Both the server's `Socket.Socket` from
 * `@effect/platform/Socket` and the client's `Socket.makeWebSocket(...)`
 * return values satisfy this shape.
 *
 * - `write(raw)` fails with `SocketWriteError` on transport rejection.
 *   The underlying `Socket.SocketError` is wrapped into `SocketWriteError`
 *   at the Connection boundary.
 * - `runRaw(handler)` returns an Effect that completes when the read
 *   side terminates. Clean close → `Effect.void`. Read-side fault →
 *   fails with `SocketReadError`. The handler is invoked once per
 *   inbound frame (text or binary).
 */
export interface SocketLike {
  readonly write: (raw: string) => Effect.Effect<void, SocketWriteError, never>;
  readonly runRaw: (
    handler: (raw: string | Uint8Array) => Effect.Effect<void, never, never>,
  ) => Effect.Effect<void, SocketReadError, never>;
}
