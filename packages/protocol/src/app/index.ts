/**
 * @file Public barrel for app RPC descriptors and app-hook protocol types.
 */
export {
  AppsRegister,
  DispatchId,
  DispatchRequest,
  DispatchAuthorize,
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
  DispatchesGet,
  MessagesAuthorize,
  validateAppManifest,
} from "./methods.js";

export type { AppManifest } from "./methods.js";
