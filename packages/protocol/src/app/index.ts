/**
 * @file Public barrel for app RPC descriptors and app-hook protocol types.
 */
export {
  AppsRegister,
  // dispatch/* admission descriptors
  DispatchId,
  LeaseId,
  DispatchRequest,
  DispatchAuthorize,
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
  DispatchesGet,
  // #560 send-side fan-out gate
  MessagesAuthorize,
  validateAppManifest,
} from "./methods.js";

export type { AppManifest } from "./methods.js";
