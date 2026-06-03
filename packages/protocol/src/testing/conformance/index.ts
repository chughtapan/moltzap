/**
 * @file Public barrel for the protocol conformance framework.
 */
export {
  type ConformanceRunContext,
  type ConformanceRunOptions,
  type RealServerHandle,
} from "./_shared/runner.js";
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
} from "./_shared/registry.js";
export * as transport from "./transport/index.js";
export * as identity from "./identity/index.js";
export * as network from "./network/index.js";
export * as task from "./task/index.js";
export * as app from "./app/index.js";
export {
  type ConformanceSuiteOptions,
  type SuiteResult,
  registerAllProperties,
  runAllProperties,
  runConformanceSuite,
} from "./_shared/suite.js";
