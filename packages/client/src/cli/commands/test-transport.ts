import { Effect } from "effect";
import {
  JSON_RPC_RESERVED_CODES,
  UnauthorizedError,
  type ParamsOf,
  type ResultOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import {
  TransportRpcError,
  type Transport as TransportSurface,
  type TransportError,
} from "../transport.js";

export interface TestTransportCall {
  readonly method: string;
  readonly params: unknown;
}

export const makeFakeTransport = (
  respond: (call: TestTransportCall) => unknown | Error,
): {
  readonly calls: TestTransportCall[];
  readonly transport: TransportSurface;
} => {
  const calls: TestTransportCall[] = [];
  const transport: TransportSurface = {
    kind: "test",
    rpc: <D extends RpcDefinition<string, any, any>>(
      definition: D,
      params: ParamsOf<D>,
    ): Effect.Effect<ResultOf<D>, TransportError> => {
      const call = { method: definition.name, params };
      calls.push(call);
      const out = respond(call);
      if (out instanceof Error) {
        return Effect.fail(
          new TransportRpcError({
            method: definition.name,
            code: UnauthorizedError.code,
            message: out.message,
          }),
        );
      }
      if (!definition.validateResult(out)) {
        return Effect.fail(
          new TransportRpcError({
            method: definition.name,
            code: JSON_RPC_RESERVED_CODES.InternalError,
            message: `Invalid fake response for ${definition.name}`,
            data: out,
          }),
        );
      }
      return Effect.succeed(out as ResultOf<D>);
    },
  };
  return { calls, transport };
};
