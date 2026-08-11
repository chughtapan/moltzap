/** @file Shared simulator test utility exports. */

// safer-arch-ignore no-public-test-helper-leak: ./test-utils is the package's explicitly allowed test-only subpath, and this index is its curated facade.

/** Re-exports the public API from `./kernel-harness.js`. */
export {
  OBSERVED_EXIT_CODE,
  Observation,
  PRIMARY_AGENT_NAME,
  REF,
  ROUTER_URL,
  assertDefaultProvenance,
  configuration,
  fakeRouterProvider,
  kernelHarness,
  memoryStorage,
  observeCompletions,
  ongoingRoster,
  testRuntimeConfiguration,
} from "./kernel-harness.js";
