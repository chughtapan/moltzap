/**
 * @file Public barrel for the protocol conformance framework.
 */
import * as transport from "./transport/index.js";
import * as identity from "./identity/index.js";
import * as delivery from "./delivery/index.js";
import * as app from "./app/index.js";

/** Re-exports the public API from `./_shared/runner.js`. */
export {
  type ConformanceRunContext,
  type ConformanceRunOptions,
  type RealServerHandle,
} from "./_shared/runner.js";
/** Re-exports the public API from `./_shared/registry.js`. */
export {
  type PropertyCategory,
  type PropertyFailure,
  type PropertyRun,
  type RegisteredProperty,
  PropertyAssertionFailure,
  PropertyInvariantViolation,
  PropertyUnavailable,
  assertProperty,
  collectProperties,
  registerProperty,
} from "./_shared/registry.js";
/** Re-exports the public API from `./_shared/suite.js`. */
export {
  type ConformanceSuiteOptions,
  type SuiteResult,
  registerAllProperties,
  runAllProperties,
  runConformanceSuite,
} from "./_shared/suite.js";
/** Re-exports the public API from `current module`. */
export { transport, identity, delivery, app };
