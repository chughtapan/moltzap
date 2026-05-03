/**
 * Conformance-suite shared helpers — small utilities used by multiple
 * property modules. Keep this file thin; promote utilities here only
 * when they would otherwise be duplicated verbatim.
 */
import type { Effect } from "effect";
import type { TestClient } from "../test-client.js";
import type {
  FrameSchemaError,
  RpcResponseError,
  RpcTimeoutError,
  TransportClosedError,
  TransportIoError,
} from "../errors.js";

/**
 * `apps/register` is server-handled but absent from the typed
 * `rpcMethods` registry (see `packages/protocol/src/rpc-registry.ts`);
 * app-sdk and `34-rpc-additions.integration.test.ts:48` use the same
 * untyped-cast path. Adding the verb to the registry is an accretive
 * change outside this sub-issue's scope; this helper localizes the cast.
 */
export function sendUntypedRpc(
  client: TestClient,
  method: string,
  params: unknown,
): Effect.Effect<
  unknown,
  | RpcResponseError
  | RpcTimeoutError
  | TransportClosedError
  | TransportIoError
  | FrameSchemaError
> {
  return (client.sendRpc as UntypedSendRpc)(method, params);
}

type UntypedSendRpc = (
  method: string,
  params: unknown,
) => Effect.Effect<
  unknown,
  | RpcResponseError
  | RpcTimeoutError
  | TransportClosedError
  | TransportIoError
  | FrameSchemaError
>;
