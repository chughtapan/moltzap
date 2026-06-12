import { RpcServer } from "@effect/rpc";
import { Deferred, Effect, Layer, Mailbox } from "effect";
import {
  makeServerChannelProtocol,
  type ChannelSink,
  type WireWrite,
} from "#transport";

/** @internal */
export const makeServerProtocolLayer = (options: {
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
  readonly sinkReady: Deferred.Deferred<ChannelSink>;
}): Layer.Layer<RpcServer.Protocol> => {
  const builder = makeServerChannelProtocol({
    write: options.write,
    disconnects: options.disconnects,
  });
  return Layer.scoped(
    RpcServer.Protocol,
    RpcServer.Protocol.make((write) =>
      builder(write).pipe(
        Effect.tap((built) => Deferred.succeed(options.sinkReady, built.sink)),
        Effect.map((built) => built.impl),
      ),
    ),
  );
};
