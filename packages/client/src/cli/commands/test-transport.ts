import { Effect } from "effect";
import {
  decodeRpcResult,
  ErrorCodes,
  type ParamsOf,
  type ResultOf,
  type RpcDefinition,
  type TSchema,
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
    rpc: <D extends RpcDefinition<string, TSchema, TSchema>>(
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
            code: ErrorCodes.Unauthorized,
            message: out.message,
          }),
        );
      }
      return decodeRpcResult(definition, out).pipe(
        Effect.mapError(
          () =>
            new TransportRpcError({
              method: definition.name,
              code: ErrorCodes.InternalError,
              message: `Invalid fake response for ${definition.name}`,
              data: out,
            }),
        ),
      );
    },
  };
  return { calls, transport };
};
