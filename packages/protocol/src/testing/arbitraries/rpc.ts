/**
 * Per-`RpcMethodName` arbitrary and the `allRpcMethods` walker.
 *
 * Tier A's A5 (RpcMap coverage) and Tier B's B1 (model equivalence) both
 * iterate every method name. Centralizing the iterator here keeps the
 * property bodies compiler-checked against `RpcMap`.
 */
import * as fc from "fast-check";
import {
  rpcMethods,
  type RpcMap,
  type RpcMethodName,
} from "../../rpc-registry.js";
import { arbitraryForParams } from "./from-typebox.js";

/**
 * A single drawn RPC invocation: the method name carries through to the
 * reference model so it can pick the matching reducer.
 */
export interface ArbitraryRpcCall<M extends RpcMethodName = RpcMethodName> {
  readonly method: M;
  readonly params: RpcMap[M]["params"];
}

/**
 * Ordered list of every `RpcMethodName`. Exposed so properties can assert
 * "every method exercised at least once" without going through `RpcMap`
 * directly.
 */
export const allRpcMethods: ReadonlyArray<RpcMethodName> = rpcMethods.map(
  (m) => m.name,
);

// Precomputed lookup from wire name → manifest, so `arbitraryCallFor` is O(1).
const methodByName = new Map(rpcMethods.map((m) => [m.name, m]));

/** Arbitrary of a valid params tree for a single, fixed RPC. */
export function arbitraryCallFor<M extends RpcMethodName>(
  method: M,
): fc.Arbitrary<ArbitraryRpcCall<M>> {
  const def = methodByName.get(method);
  if (def === undefined) {
    throw new Error(`arbitraryCallFor: unknown method ${String(method)}`);
  }
  return arbitraryForParams(def.paramsSchema).map(
    (params) =>
      ({
        method,
        params: params as RpcMap[M]["params"],
      }) as const,
  );
}

/**
 * Arbitrary that draws any method name + matching params. Used by Tier A
 * A5 and by Tier E E2's cross-RPC fuzz.
 */
export function arbitraryAnyCall(): fc.Arbitrary<ArbitraryRpcCall> {
  if (allRpcMethods.length === 0) {
    throw new Error("arbitraryAnyCall: rpcMethods empty");
  }
  return fc.constantFrom(...allRpcMethods).chain((m) => arbitraryCallFor(m));
}
