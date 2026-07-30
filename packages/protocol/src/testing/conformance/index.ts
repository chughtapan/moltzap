/**
 * @file Public barrel for the protocol conformance framework.
 */
import * as transport from "./transport/index.js";
import * as identity from "./identity/index.js";
import * as network from "./network/index.js";
import * as task from "./task/index.js";
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
export { transport, identity, network, task, app };
