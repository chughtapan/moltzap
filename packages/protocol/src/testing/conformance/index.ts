/**
 * @file Public barrel for the protocol conformance framework.
 */
import * as transport from "./transport/index.js";
import * as identity from "./identity/index.js";
import * as network from "./network/index.js";
import * as task from "./task/index.js";
import * as app from "./app/index.js";

export {
  type ConformanceRunContext,
  type ConformanceRunOptions,
  type RealServerHandle,
} from "./_shared/runner.js";
export {
  assertProperty,
  collectProperties,
  PropertyAssertionFailure,
  type PropertyCategory,
  type PropertyFailure,
  PropertyInvariantViolation,
  type PropertyRun,
  PropertyUnavailable,
  type RegisteredProperty,
  registerProperty,
} from "./_shared/registry.js";
export {
  type ConformanceSuiteOptions,
  registerAllProperties,
  runAllProperties,
  runConformanceSuite,
  type SuiteResult,
} from "./_shared/suite.js";
export { app, identity, network, task, transport };
