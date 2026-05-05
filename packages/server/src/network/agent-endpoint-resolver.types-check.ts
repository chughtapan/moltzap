/**
 * Type-level negative canary — Phase 9b consumer-migration (sub-issue #460
 * amendment).
 *
 * Asserts that the resolver's internal `ConnectionId` brand cannot leak as
 * a wire-level `EndpointAddress`. Pre-Phase-9b the `agent-conn` kind in
 * `EndpointAddress` was the leak: callers minted `tm:agent-conn:<connId>`
 * from a `ConnectionId` and the resolver indexed by that wrapped form.
 * Phase 9b drops the wrapping; this canary closes the door so a future
 * edit cannot re-introduce the assignability.
 *
 * Mechanics: the assignment below is expected to fail at compile time
 * with TS2322 because `ConnectionId` is branded with `"ConnectionId"`
 * and `EndpointAddress` is branded with `"EndpointAddress"`. The two
 * brands are nominal and disjoint, so no structural subtyping path
 * lets the assignment succeed. `@ts-expect-error` swallows the error;
 * if a future edit makes the types compatible, the directive becomes
 * "unused" and `pnpm typecheck` fails with TS2578.
 *
 * Build-only artifact: typechecked by `pnpm typecheck` (the filename
 * does not match the `*.test.ts` exclude). No runtime exports.
 */
import type { EndpointAddress } from "@moltzap/protocol/network";
import type { ConnectionId } from "./agent-endpoint-resolver.js";

/**
 * Type-only assertion that `ConnectionId` is NOT structurally
 * assignable to `EndpointAddress`. The conditional resolves to `true`
 * iff the disjoint-brand check holds; the `extends true` constraint
 * gates the alias's existence on that resolution. A future edit that
 * makes the brands compatible flips the conditional to `false` and
 * the assignment fails to compile under `pnpm typecheck`.
 *
 * Kept type-only — no runtime emit — so this file ships zero bytes to
 * `dist` even though the resolver tsconfig does not exclude
 * `*.types-check.ts`.
 */
type _ConnectionIdLeakCanary<
  T extends [ConnectionId] extends [EndpointAddress] ? false : true,
> = T;

export type _ConnectionIdLeakCanaryAssertion = _ConnectionIdLeakCanary<true>;
