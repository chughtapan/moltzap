/**
 * `_shared/suite.ts` — skeleton showing the post-reorg aggregation shape.
 *
 * The implementer (sub-issue #546) replaces this file with the moved
 * legacy `suite.ts`, updating only the property-registration walk to
 * gather from the per-layer `<layer>/index.ts` arrays. Every other
 * symbol (`ConformanceSuiteOptions`, `SuiteResult`, `runAllProperties`,
 * `runConformanceSuite`, `allowedServerCoverageGaps`) ports verbatim.
 *
 * Schematic (the only function changing semantics from the legacy
 * `registerAllProperties`):
 *
 * ```ts
 * import { TRANSPORT_PROPERTIES } from "../transport/index.js";
 * import { IDENTITY_PROPERTIES } from "../identity/index.js";
 * import { NETWORK_PROPERTIES } from "../network/index.js";
 * import { TASK_PROPERTIES } from "../task/index.js";
 * import { APP_PROPERTIES } from "../app/index.js";
 *
 * export function registerAllProperties(ctx: ConformanceRunContext): void {
 *   for (const fn of [
 *     ...TRANSPORT_PROPERTIES,
 *     ...IDENTITY_PROPERTIES,
 *     ...NETWORK_PROPERTIES,
 *     ...TASK_PROPERTIES,
 *     ...APP_PROPERTIES,
 *   ]) {
 *     fn(ctx);
 *   }
 * }
 * ```
 *
 * Order MUST match the legacy walk for byte-equivalent baseline output:
 * the legacy `registerAllProperties` registers `schemaConformance` →
 * `rpcSemantics` → `delivery` → `adversity` → `boundary` → `presence`
 * → `dispatchAdmission`. Each layer's `<LAYER>_PROPERTIES` array
 * concatenates the corresponding subset (see plan §2 for the per-property
 * layer map).
 *
 * The `allowedServerCoverageGaps` table moves verbatim; the property
 * IDs in it (`adversity/backpressure`, `delivery/hook-gated-delivery`,
 * etc.) stay as the registry-emitted `<category>/<name>` form because
 * `registerProperty` derives the category from the call-site, not the
 * file path. See plan §7.
 */
export {};
