/**
 * @file Public barrel for app manifest and app-hook protocol types.
 */
export {
  MessagesAuthorize,
  TaskCreate,
  validateAppManifest,
} from "./methods.js";

export type { AppManifest } from "./methods.js";
export type {
  AppCallbackHandlers,
  AppCallbackRpcDefinition,
  HandlerSlot,
} from "./methods.js";
