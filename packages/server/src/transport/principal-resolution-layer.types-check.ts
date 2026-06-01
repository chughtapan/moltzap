/**
 * @file Type canary for the per-connection principal-resolution Layer
 * (`transport/principal-resolution-layer.ts`).
 *
 * The factory is built ahead of the live-connection cutover and is wired to no
 * socket yet. This canary is its live type consumer AND pins the per-socket
 * scope encoding the design's security crux relies on (§C.1):
 *
 *   - the factory CLOSES OVER a `ConnectionId` — it cannot be constructed
 *     without a per-connection key, so there is no app-level shared instance
 *     that would collide every connection on the constant `MUX_CLIENT_ID`;
 *   - it requires ONLY `ConnectionManagerTag` (the app-level shared manager it
 *     peeks against — the lone shared dependency);
 *   - it provides BOTH `PrincipalResolution` (the gate + `CurrentPrincipal`) and
 *     `ConnectionTag` (the live arm for the unauth path).
 *
 * If the factory loses its `connId` parameter, drops the `ConnectionManagerTag`
 * requirement, or stops providing either output, the equality below stops
 * compiling.
 */
import type { Layer } from "effect";
import type { PrincipalResolution } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { ConnectionManagerTag, ConnectionTag } from "../app/layers.js";
import { makePrincipalResolutionLayer } from "./principal-resolution-layer.js";
import type {
  PrincipalKindTable,
  PrincipalKindPolicy,
} from "./server-method-bindings.js";

// Compile-time equality helper.
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

type Factory = typeof makePrincipalResolutionLayer;

// The factory's first parameter is the per-connection key (no shared instance).
type _ClosesOverConnId = Expect<Equal<Parameters<Factory>[0], ConnectionId>>;
// The second parameter is the projected policy table.
type _TakesPolicyTable = Expect<
  Equal<Parameters<Factory>[1], PrincipalKindTable>
>;
// The Layer provides both outputs and requires only the shared manager.
type _LayerShape = Expect<
  Equal<
    ReturnType<Factory>,
    Layer.Layer<
      PrincipalResolution | ConnectionTag,
      never,
      ConnectionManagerTag
    >
  >
>;
// The policy table's value carries the principal-kind policy each gated method
// enforces — `callablePrincipal` + `requiresActive`.
type _PolicyShape = Expect<
  Equal<
    PrincipalKindPolicy,
    PrincipalKindTable extends ReadonlyMap<infer _K, infer V> ? V : never
  >
>;

export type { _ClosesOverConnId, _TakesPolicyTable, _LayerShape, _PolicyShape };
