/**
 * @file Type canaries for the channel-multiplexed `@effect/rpc` transport
 * (`transport/native-mux.ts`).
 *
 * The mux is built ahead of the live-connection cutover and is wired to no
 * socket yet. These canaries are its live type consumer (so the unused-export
 * pass does not flag the builders dead) AND the load-bearing invariant the
 * module guarantees: the impl record each channel builder returns is exactly
 * the shape the corresponding low-level `Protocol.make` extension point
 * accepts. If `@effect/rpc` changes either protocol-impl contract, these stop
 * compiling here rather than at the live-wiring site.
 *
 * `RpcServer.Protocol.make` / `RpcClient.Protocol.make` each take a callback
 * returning an Effect of the impl record; the canaries map the builder's
 * `impl`/`sink` result down to `impl`, so the compiler checks `impl` against
 * the extension point's declared return shape.
 */
import { Effect, Mailbox } from "effect";
import { RpcClient, RpcServer } from "@effect/rpc";
import {
  makeClientChannelProtocol,
  makeServerChannelProtocol,
  type WireWrite,
} from "./native-mux.js";

declare const wireWrite: WireWrite;
declare const serverDisconnects: Mailbox.Mailbox<number>;

// The server impl record satisfies `RpcServer.Protocol.make`'s callback
// return contract: the make wrapper accepts exactly the fields the builder
// emits (no excess, none missing).
const serverBuilder = makeServerChannelProtocol({
  channel: "c2s",
  write: wireWrite,
  disconnects: serverDisconnects,
});
export const serverProtocolCanary = RpcServer.Protocol.make((write) =>
  serverBuilder(write).pipe(Effect.map((built) => built.impl)),
);

// The client impl record satisfies `RpcClient.Protocol.make`'s callback
// return contract for the same reason.
const clientBuilder = makeClientChannelProtocol({
  channel: "s2c",
  write: wireWrite,
});
export const clientProtocolCanary = RpcClient.Protocol.make((write) =>
  clientBuilder(write).pipe(Effect.map((built) => built.impl)),
);
