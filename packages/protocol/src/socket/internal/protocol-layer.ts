import { RpcServer } from "@effect/rpc";
import { Deferred, Effect, Layer, type Mailbox } from "effect";
import {
  makeServerChannelProtocol,
  type ChannelSink,
  type WireWrite,
} from "#transport";

/**
 * Creates the server-side RPC protocol layer over the supplied wire channel.
 *
 * @param options Options that control the operation.
 * @param options.write Value supplied to the operation.
 * @param options.disconnects Value supplied to the operation.
 * @param options.sinkReady Value supplied to the operation.
 * @internal
 * @returns The created server protocol layer.
 */
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
