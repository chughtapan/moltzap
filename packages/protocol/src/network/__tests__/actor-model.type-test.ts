/**
 * Compile-time negative canary for spec #135 Invariant 18 (flat-barrel ban).
 *
 * Arch-F actor-model types MUST be reachable only via `@moltzap/protocol/network`,
 * never via the flat package entry `@moltzap/protocol`. A prior arch-F attempt
 * added a re-export to the flat barrel; this file is the structural guard that
 * makes that regression a compile error, not a convention.
 *
 * Mechanism — each import below targets the flat barrel and is marked
 * `@ts-expect-error`. If the flat barrel starts re-exporting these names, the
 * imports resolve, the expected error disappears, and TypeScript emits
 * TS2578 ("Unused '@ts-expect-error' directive") — the build fails.
 *
 * Scope limitation — the canary asserts the three arch-F-exclusive names
 * (`EndpointKind`, `EndpointRegistration`, `AuthenticatedIdentity`). The names
 * `UserId` and `AgentId` already appear in the flat barrel as TypeBox schema
 * VALUES (not brand types) via `packages/protocol/src/schema/primitives.ts`.
 * That legacy collision is out of scope for this slice; the arch-F nominal
 * brands live only under the subpath. Dropping the legacy TypeBox exports from
 * the flat barrel is a downstream task (tracked separately under the spec #135
 * Invariant 18 enforcement effort).
 *
 * This file is typechecked under the protocol package's `tsconfig.json`;
 * vitest never executes it at runtime. The type assertions are the test.
 */

// @ts-expect-error — `EndpointKind` must not be reachable via the flat barrel (spec #135 Invariant 18).
import type { EndpointKind as _EndpointKindFlat } from "@moltzap/protocol";

// @ts-expect-error — `EndpointRegistration` must not be reachable via the flat barrel (spec #135 Invariant 18).
import type { EndpointRegistration as _EndpointRegistrationFlat } from "@moltzap/protocol";

// @ts-expect-error — `AuthenticatedIdentity` must not be reachable via the flat barrel (spec #135 Invariant 18).
import type { AuthenticatedIdentity as _AuthenticatedIdentityFlat } from "@moltzap/protocol";

// Silence `noUnusedLocals` for the type-only aliases above.
export type _FlatBarrelCanary =
  | _EndpointKindFlat
  | _EndpointRegistrationFlat
  | _AuthenticatedIdentityFlat;
