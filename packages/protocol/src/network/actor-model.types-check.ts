/**
 * Type-level negative canary — Phase 3 / Slice F (#421).
 *
 * Asserts the actor-model brand-type names stay scoped to `./actor-model`
 * and are NOT re-exported (as types or values) from the flat barrel
 * `packages/protocol/src/index.ts`. Phase 2 (#420) freed those name slots so
 * this module could own them; this file holds the line for future edits.
 *
 * Mechanics:
 *   each `import type { X } from "../index.js"` is expected to fail at
 *   compile time with TS2305 "Module has no exported member 'X'" because the
 *   flat barrel does not export the name. `@ts-expect-error` swallows that
 *   error. If a future edit re-exports the name from `index.ts`, the import
 *   succeeds and `@ts-expect-error` becomes "unused" — `tsc --noEmit` fails
 *   with TS2578 ("Unused '@ts-expect-error' directive") and the canary
 *   fires under `pnpm typecheck`.
 *
 * Build-only artifact: typechecked by `pnpm typecheck` (this filename does
 * not match the `*.test.ts` exclude in `packages/protocol/tsconfig.json`).
 * No runtime exports.
 *
 * Companion file `actor-model.test.ts` covers the runtime side
 * (`Object.keys(flatBarrel)` assertion).
 */

// @ts-expect-error — UserId must not be re-exported from the protocol flat barrel.
import type { UserId as _UserId } from "../index.js";
// @ts-expect-error — AgentId must not be re-exported from the protocol flat barrel.
import type { AgentId as _AgentId } from "../index.js";
// @ts-expect-error — EndpointAddress must not be re-exported from the protocol flat barrel.
import type { EndpointAddress as _EndpointAddress } from "../index.js";
// @ts-expect-error — EndpointKind must not be re-exported from the protocol flat barrel.
import type { EndpointKind as _EndpointKind } from "../index.js";
// @ts-expect-error — EndpointRegistration must not be re-exported from the protocol flat barrel.
import type { EndpointRegistration as _EndpointRegistration } from "../index.js";
// @ts-expect-error — AuthenticatedIdentity must not be re-exported from the protocol flat barrel.
import type { AuthenticatedIdentity as _AuthenticatedIdentity } from "../index.js";

// Reference each suppressed import so `no-unused-vars` doesn't flag them
// (and so a future `noUnusedLocals` upgrade keeps the canary honest). Type
// aliases erase at emit; this carries no runtime cost.
export type _ActorModelBarrelCanary =
  | _UserId
  | _AgentId
  | _EndpointAddress
  | _EndpointKind
  | _EndpointRegistration
  | _AuthenticatedIdentity;
