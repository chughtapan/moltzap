/**
 * Reference-model dispatch: one reducer keyed by `RpcMethodName`.
 *
 * The union `RpcModelResult` mirrors every observable shape Tier B must
 * compare against the real server — success, typed error (authz, schema),
 * and the prospective events the server is expected to emit as a side
 * effect of the call.
 *
 * Exhaustiveness: the reducer takes `ArbitraryRpcCall` (discriminated on
 * `method`) so the TS compiler flags an unhandled method name if
 * `rpcMethods` grows without the model being updated.
 */
import type { RpcMap, RpcMethodName } from "../../rpc-registry.js";
import type { EventFrame } from "../../schema/frames.js";
import type { ArbitraryRpcCall } from "../arbitraries/rpc.js";
import type { ReferenceState } from "./state.js";

/**
 * Observable outcome of one RPC against the model, in the same shape the
 * real server puts on the wire. Tier B's B1 asserts
 * `deepEqual(serverResponse, modelResponse)` modulo opaque fields (IDs,
 * tokens — extracted to a named canonicalizer in the implementer step).
 */
export type RpcModelResult<M extends RpcMethodName = RpcMethodName> =
  | {
      readonly _tag: "ok";
      readonly result: RpcMap[M]["result"];
      readonly events: ReadonlyArray<EventFrame>;
    }
  | {
      readonly _tag: "error";
      readonly code: number;
      readonly message: string;
      readonly events: ReadonlyArray<EventFrame>;
    };

/**
 * Pure reducer: given state + call, yield the next state and the
 * observable outcome. No I/O. No clocks. No exceptions — every failure
 * flows through `_tag: "error"`.
 */
export function applyCall<M extends RpcMethodName>(
  state: ReferenceState,
  call: ArbitraryRpcCall<M>,
): { readonly next: ReferenceState; readonly outcome: RpcModelResult<M> } {
  throw new Error("not implemented");
}

/**
 * Idempotence predicate (B5). Returns true for RPCs whose contract says
 * replay is a no-op. Lookup is compile-time safe against `RpcMethodName`.
 */
export function isIdempotent(method: RpcMethodName): boolean {
  throw new Error("not implemented");
}

/**
 * Authorization oracle (B2 / B3). Returns the expected typed outcome for a
 * call made by `agentId`. Property code compares the real server's error
 * to this.
 */
export function authorizationOutcome(
  state: ReferenceState,
  call: ArbitraryRpcCall,
  agentId: string,
): "allow" | "deny-unauthenticated" | "deny-forbidden" {
  throw new Error("not implemented");
}
