/** @file App identity and endpoint registration barrel. */

/** Re-exports the public API from `./layer.js`. */
export { AppAuthServiceTag, AppEndpointRegistryTag } from "./layer.js";
/** Re-exports the public API from `./endpoint-registry.js`. */
export { AppEndpointRegistry } from "./endpoint-registry.js";
/** Re-exports the public API from `./callback-rpc.js`. */
export { callAppRpc, wrapHookEffectWithEnvelope } from "./callback-rpc.js";
/** Re-exports the public API from `./registry.js`. */
export type { AppEndpoint, AppRegistration } from "./registry.js";
