/**
 * `_shared/` barrel — re-exports the cross-layer infrastructure
 * (`registry`, `runner`, `env`, `_helpers`, `coverage-policy`,
 * `suite`). Layer files import from the named files directly; this
 * barrel exists so the conformance root re-export can spread the
 * public surface from one place.
 */
export {
  type ConformanceArtifact,
  type ConformanceRunContext,
  type ConformanceRunOptions,
  type RealServerHandle,
  acquireRunContext,
  runConformance,
} from "./runner.js";
export {
  type PropertyCategory,
  type PropertyFailure,
  type PropertyRun,
  type RegisteredProperty,
  PropertyAssertionFailure,
  PropertyDeferred,
  PropertyInvariantViolation,
  PropertyUnavailable,
  assertProperty,
  collectProperties,
  registerProperty,
} from "./registry.js";
export {
  type ConformanceSuiteOptions,
  type SuiteResult,
  registerAllProperties,
  runAllProperties,
  runConformanceSuite,
} from "./suite.js";
