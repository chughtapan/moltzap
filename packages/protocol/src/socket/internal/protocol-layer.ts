import { RpcServer } from "@effect/rpc";
import { Deferred, Effect, Layer, Mailbox } from "effect";
import {
  type ChannelSink,
  makeServerChannelProtocol,
  type WireWrite,
} from "#transport";

/** @internal */
export const makeServerProtocolLayer = (options: {
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
  readonly sinkReady: Deferred.Deferred<ChannelSink>;
}): Layer.Layer<RpcServer.Protocol> => {
  const { write, disconnects, sinkReady } = options;
  const builder = makeServerChannelProtocol({ write, disconnects });
  return Layer.scoped(
    RpcServer.Protocol,
    RpcServer.Protocol.make((write) =>
      builder(write).pipe(
        Effect.tap((built) => Deferred.succeed(sinkReady, built.sink)),
        Effect.map((built) => built.impl),
      ),
    ),
  );
};
