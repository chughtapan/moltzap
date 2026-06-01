/**
 * @file Per-connection server→client notification delivery buffers.
 *
 * Under the native `@effect/rpc` wire, notifications no longer ride raw
 * `socket.write` frames. A connection opens ONE server→client streaming RPC
 * (`notifications/stream`); its handler drains this connection's bounded
 * {@link Mailbox}, emitting each buffered notification frame as a stream chunk
 * the engine serializes through the c2s channel. The fan-out services
 * (`NetworkSendService`, presence/message/conversation/contacts/task fan-out)
 * `offer` an already-encoded notification frame string into the recipient
 * connection's Mailbox instead of writing the socket directly.
 *
 * The registry keys one Mailbox per `ConnectionId`, created at socket open and
 * finalized at close. A notification offered for a connection with no live
 * Mailbox (closed, or never opened its stream) is dropped — the same
 * at-most-once posture the raw-frame path had (a write to a gone socket was a
 * logged no-op).
 */
import { Effect, Mailbox, MutableHashMap, Option } from "effect";
import type { ConnectionId } from "@moltzap/protocol/network";

/** Bounded capacity per connection's notification buffer. */
const NOTIFICATION_MAILBOX_CAPACITY = 8192;

/**
 * Registry of per-connection notification Mailboxes. One instance per server
 * lifetime; the socket handler registers a Mailbox at open and removes it at
 * close, the streaming handler drains it, the fan-out services offer into it.
 */
export class NotificationMailboxRegistry {
  private readonly byConn = MutableHashMap.empty<
    ConnectionId,
    Mailbox.Mailbox<string>
  >();

  /**
   * Create + register a bounded notification Mailbox for `connId`. Returns the
   * Mailbox so the socket handler can hand it to the streaming RPC and run the
   * finalizer. Idempotent at the registry level: a second register for the same
   * connId replaces the entry (a fresh stream open after reconnect).
   */
  register(connId: ConnectionId): Effect.Effect<Mailbox.Mailbox<string>> {
    return Effect.gen(this, function* () {
      const mailbox = yield* Mailbox.make<string>(
        NOTIFICATION_MAILBOX_CAPACITY,
      );
      MutableHashMap.set(this.byConn, connId, mailbox);
      return mailbox;
    });
  }

  /**
   * Offer an already-encoded notification frame to `connId`'s Mailbox. A
   * missing entry (no live stream) drops the frame — the at-most-once posture
   * the raw-frame socket write had. A full Mailbox drops the oldest per the
   * bounded sliding semantics.
   */
  offer(connId: ConnectionId, frame: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const mailbox = MutableHashMap.get(this.byConn, connId);
      if (Option.isNone(mailbox)) return;
      yield* mailbox.value.offer(frame).pipe(Effect.asVoid);
    });
  }

  /**
   * Remove + end `connId`'s Mailbox at socket close. Ending the Mailbox
   * completes the draining streaming handler's `Stream` so the engine closes
   * the s→c stream for this connection.
   */
  remove(connId: ConnectionId): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const mailbox = MutableHashMap.get(this.byConn, connId);
      if (Option.isNone(mailbox)) return;
      MutableHashMap.remove(this.byConn, connId);
      yield* mailbox.value.end;
    });
  }
}
