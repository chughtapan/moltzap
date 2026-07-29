/**
 * @file Type canaries for the two-engine `@effect/rpc` transport
 * (`transport/mux.ts`).
 *
 * These canaries pin the load-bearing invariant the module guarantees: the
 * impl record each channel builder returns is exactly the shape the
 * corresponding low-level `Protocol.make` extension point accepts. If
 * `@effect/rpc` changes either protocol-impl contract, these stop compiling
 * here rather than at the live-wiring site (`MoltZapServer`,
 * `socket/lifecycle.ts`).
 *
 * `RpcServer.Protocol.make` / `RpcClient.Protocol.make` each take a callback
 * returning an Effect of the impl record; the canaries map the builder's
 * `impl`/`sink` result down to `impl`, so the compiler checks `impl` against
 * the extension point's declared return shape.
 */
import { Effect, type Mailbox } from "effect";
import { RpcClient, RpcServer } from "@effect/rpc";
import {
  makeClientChannelProtocol,
  makeServerChannelProtocol,
  type WireWrite,
} from "./mux.js";

declare const wireWrite: WireWrite;
declare const serverDisconnects: Mailbox.Mailbox<number>;

// The server impl record satisfies `RpcServer.Protocol.make`'s callback
// return contract: the make wrapper accepts exactly the fields the builder
// emits (no excess, none missing).
const serverBuilder = makeServerChannelProtocol({
  write: wireWrite,
  disconnects: serverDisconnects,
});
/** Provides the server protocol canary runtime value. */
export const serverProtocolCanary = RpcServer.Protocol.make((write) =>
  serverBuilder(write).pipe(Effect.map((built) => built.impl)),
);

// The client impl record satisfies `RpcClient.Protocol.make`'s callback
// return contract for the same reason.
const clientBuilder = makeClientChannelProtocol({
  write: wireWrite,
});
/** Provides the client protocol canary runtime value. */
export const clientProtocolCanary = RpcClient.Protocol.make((write) =>
  clientBuilder(write).pipe(Effect.map((built) => built.impl)),
);
