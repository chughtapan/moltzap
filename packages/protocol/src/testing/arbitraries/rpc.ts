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
import { applyCall } from "../models/dispatch.js";
import { initialReferenceState } from "../models/state.js";
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

/**
 * The set of `RpcMethodName`s the reference model predicts `_tag: "ok"`
 * for on `initialReferenceState` — derived mechanically at module load
 * by probing `applyCall` with a single drawn params value per method.
 *
 * Per architect #197 §2.2: this is NOT a hand-curated list. Methods
 * move in/out of the confident set automatically when `applyCall`'s
 * `allowNoEvents` / `uncertainError` split moves, so the sampling
 * distribution tracks the model.
 *
 * **Param-invariance contract:** every kept method is treated as
 * oracle-confident for every params value. If a future `applyCall`
 * amendment branches on `call.params`, the safety-net guard in
 * `registerModelEquivalence` (rpc-semantics.ts) fires loudly on the
 * first non-confident draw and the derivation must widen from the
 * single-probe form to an `fc.sample`-based invariant check.
 */
export const confidentOracleMethods: ReadonlyArray<RpcMethodName> = (() => {
  // `models/dispatch.ts` imports `ArbitraryRpcCall` as a type-only
  // reference, so the values imported above (`applyCall`,
  // `initialReferenceState`) are safe to call at module load.
  const kept: RpcMethodName[] = [];
  for (const method of allRpcMethods) {
    const [sample] = fc.sample(arbitraryCallFor(method), 1);
    if (sample === undefined) continue;
    const outcome = applyCall(initialReferenceState, sample).outcome;
    if (outcome._tag === "ok") kept.push(method);
  }
  return kept;
})();

/**
 * Draw a call from the model's confident-oracle set. Per architect
 * #197 §2.2 literal shape: `fc.constantFrom(...kept).chain(
 * arbitraryCallFor)`. Probe at module load uses the same
 * `arbitraryCallFor(m)` generator as execution — so confidence is
 * checked on the same distribution the property exercises.
 *
 * If a kept method turns out to be param-sensitive under a later
 * draw (model predicts ok for the one probe sample but rejects a
 * subsequent arbitrary-drawn params), the safety-net guard in
 * `registerModelEquivalence` raises `PropertyInvariantViolation`
 * pointing at this file — the fix is to widen the derivation (probe
 * K > 1 samples and keep only methods where every probe predicts ok)
 * per the architect's contract. Single-probe is sufficient when
 * `applyCall` is method-only (today).
 */
export function arbitraryConfidentCall(): fc.Arbitrary<ArbitraryRpcCall> {
  if (confidentOracleMethods.length === 0) {
    throw new Error(
      "arbitraryConfidentCall: model has zero confident-oracle methods; flag needs-structural-rework",
    );
  }
  return fc
    .constantFrom(...confidentOracleMethods)
    .chain((method) => arbitraryCallFor(method));
}
