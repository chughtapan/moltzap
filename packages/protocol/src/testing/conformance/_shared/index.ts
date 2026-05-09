/**
 * Conformance _shared/ — category-agnostic infrastructure that every
 * layer's properties depend on.
 *
 * Contents (carved out of legacy `conformance/` root in Phase 1A
 * implementation):
 *   - registry.ts        — property registry + tagged failure ADTs
 *   - runner.ts          — `acquireRunContext`, `RealServerHandle`
 *   - env.ts             — `conformanceArtifactDirFromEnv`
 *   - _helpers.ts        — `sendUntypedRpc`, `requireRight`
 *   - coverage-policy.ts — `isAllowedCoverageGap`, `AllowedCoverageGap`
 *   - suite.ts           — `runConformanceSuite`, `runAllProperties`,
 *                          `registerAllProperties` (gathers from
 *                          `<layer>/index.ts` arrays)
 *
 * Phase 1A interface stub. Implementer (sub-issue #546) `git mv`s the
 * existing files in here verbatim and updates internal import paths
 * (`./runner.js` → still `./runner.js` since they stay sibling under
 * `_shared/`).
 */
export {};
