/**
 * @file Negative barrel canary — the package public-surface encapsulation
 * boundary. Lives at the package root because the barrel it tests is the root
 * `./index.js`; importing it here is a sibling reference, not a folder→root
 * cycle.
 *
 * Locks the boundary: `AuthenticatedIdentity` is network-internal and stays
 * scoped to `network/actor-model`; it must NOT leak through the flat
 * `@moltzap/protocol` barrel. The invariant is compile-time-only because "this
 * symbol is not exported" is a fact about the module graph that no runtime
 * check can observe.
 *
 * How to read it: the `import type` below is EXPECTED to fail with TS2305
 * ("no exported member"); the `@ts-expect-error` directive swallows that
 * expected error. If a future edit re-exports the name from `index.ts`,
 * the import succeeds, the directive becomes unused, and `tsc --noEmit`
 * fails with TS2578 ("Unused '@ts-expect-error' directive"). The failure
 * mode is inverted on purpose: the canary breaks when the leak appears.
 */

// @ts-expect-error — AuthenticatedIdentity must not be re-exported from the protocol flat barrel.
import type { AuthenticatedIdentity as _AuthenticatedIdentity } from "./index.js";

export type _BarrelEncapsulationCanary = _AuthenticatedIdentity;
