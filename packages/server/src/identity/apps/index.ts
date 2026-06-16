/** @file App identity and endpoint registration barrel. */

export { AppAuthService } from "./auth.service.js";
export { installDefaultApp } from "./default-app.js";
export { AppEndpointRegistry } from "./endpoint-registry.js";
export { callAppRpc, wrapHookEffectWithEnvelope } from "./callback-rpc.js";
export type { AppEndpoint, AppRegistration } from "./registry.js";
