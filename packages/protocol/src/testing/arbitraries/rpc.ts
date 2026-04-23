/**
 * Per-`RpcMethodName` arbitrary and the `allRpcMethods` walker.
 *
 * Tier A's A5 (RpcMap coverage) and Tier B's B1 (model equivalence) both
 * iterate every method name. Centralizing the iterator here keeps the
 * property bodies compiler-checked against `RpcMap`.
 */
import type { Arbitrary } from "fast-check";
import type { RpcMap, RpcMethodName } from "../../rpc-registry.js";

/**
 * A single drawn RPC invocation: the method name carries through to the
 * reference model so it can pick the matching reducer.
 */
export interface ArbitraryRpcCall<M extends RpcMethodName = RpcMethodName> {
  readonly method: M;
  readonly params: RpcMap[M]["params"];
}

/** Arbitrary of a valid params tree for a single, fixed RPC. */
export function arbitraryCallFor<M extends RpcMethodName>(
  method: M,
): Arbitrary<ArbitraryRpcCall<M>> {
  throw new Error("not implemented");
}

/**
 * Arbitrary that draws any method name + matching params. Used by Tier A
 * A5 and by Tier E E2's cross-RPC fuzz.
 */
export function arbitraryAnyCall(): Arbitrary<ArbitraryRpcCall> {
  throw new Error("not implemented");
}

/**
 * Ordered list of every `RpcMethodName`. Exposed so properties can assert
 * "every method exercised at least once" without going through `RpcMap`
 * directly. Shape is read-only literal tuple so compile-time coverage
 * checks are possible.
 */
export const allRpcMethods: ReadonlyArray<RpcMethodName> = (() => {
  throw new Error("not implemented");
})();
