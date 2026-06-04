/**
 * Per-method arbitrary and the `allRpcMethods` walker.
 *
 * Properties that iterate every method name (e.g. RpcMap coverage) share
 * this iterator so their bodies stay compiler-checked against `RpcMap`.
 */
import * as fc from "fast-check";
import { Data } from "effect";
import {
  serverRpcMethods,
  type AnyServerRpcDefinition,
} from "../../engine/rpc-method-groups.js";
import { arbitraryFromSchema } from "./schema-arbitrary.js";

type MethodName = (typeof serverRpcMethods)[number]["name"];

class RpcArbitraryInvariantError extends Data.TaggedError(
  "RpcArbitraryInvariantError",
)<{
  readonly message: string;
}> {}

/**
 * A single drawn RPC invocation: the method name selects the wire
 * definition and the params tree is drawn from that definition's schema.
 */
export interface ArbitraryRpcCall {
  readonly definition: AnyServerRpcDefinition;
  readonly method: MethodName;
  readonly params: unknown;
}

/**
 * Ordered list of every wire method name. Exposed so properties can
 * assert "every method exercised at least once" without going through
 * `RpcMap` directly.
 */
export const allRpcMethods: ReadonlyArray<MethodName> = serverRpcMethods.map(
  (m) => m.name,
);

// Precomputed lookup from wire name → manifest, so `arbitraryCallFor` is O(1).
const methodByName = new Map<MethodName, AnyServerRpcDefinition>(
  serverRpcMethods.map((m) => [m.name, m as AnyServerRpcDefinition]),
);

/** Arbitrary of a valid params tree for a single, fixed RPC. */
export function arbitraryCallFor(
  method: MethodName,
): fc.Arbitrary<ArbitraryRpcCall> {
  const def = methodByName.get(method);
  if (def === undefined) {
    throw new RpcArbitraryInvariantError({
      message: `arbitraryCallFor: unknown method ${String(method)}`,
    });
  }
  return arbitraryFromSchema(def.paramsSchema).map(
    (params) =>
      ({
        definition: def,
        method,
        params,
      }) as const,
  );
}

/**
 * Arbitrary that draws any method name + matching params. Used by the
 * RpcMap-coverage property and the cross-RPC fuzz property.
 */
export function arbitraryAnyCall(): fc.Arbitrary<ArbitraryRpcCall> {
  // Every catalog method is WS-dispatched, so the WS-driven properties sample
  // the whole catalog.
  if (allRpcMethods.length === 0) {
    throw new RpcArbitraryInvariantError({
      message: "arbitraryAnyCall: no WS-callable methods",
    });
  }
  return fc.constantFrom(...allRpcMethods).chain((m) => arbitraryCallFor(m));
}
