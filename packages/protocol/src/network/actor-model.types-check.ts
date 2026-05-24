// Type-level negative canary: actor-model's network-internal type stays scoped
// to `./actor-model` and is NOT re-exported via the flat `@moltzap/protocol`
// barrel. The `import type` is expected to fail with TS2305 — `@ts-expect-error`
// swallows that error. If a future edit re-exports the name from `index.ts`,
// the import succeeds and `tsc --noEmit` fails with TS2578 ("Unused
// '@ts-expect-error' directive").

// @ts-expect-error — AuthenticatedIdentity must not be re-exported from the protocol flat barrel.
import type { AuthenticatedIdentity as _AuthenticatedIdentity } from "../index.js";

export type _ActorModelBarrelCanary = _AuthenticatedIdentity;
