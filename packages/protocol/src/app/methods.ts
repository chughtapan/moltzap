/**
 * @file App-domain RPC descriptors, split by concern across three modules and
 * re-exported here as the app catalog's single import surface:
 *
 * - `manifest.ts` — the app manifest + hook policy schemas + `apps/register`.
 * - `dispatch.ts` — the recipient admission surface (`dispatch/*`,
 *   `dispatches/*`) + the dispatch lease record.
 * - `app-callbacks.ts` — the server→TM reverse callbacks (`messages/authorize`,
 *   `task/create`).
 *
 * The three `appRpcMethods` / `appCallbackMethods` / `appNotifications`
 * catalogs are assembled in the engine group module, which is their consumer.
 */
export { AppsRegister, validateAppManifest } from "./manifest.js";
export type { AppManifest } from "./manifest.js";

export {
  DispatchNotFoundError,
  DispatchId,
  DispatchRequest,
  DispatchAuthorize,
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
  DispatchesGet,
} from "./dispatch.js";

export { MessagesAuthorize, TaskCreate } from "./app-callbacks.js";

import { AppsRegister } from "./manifest.js";
import {
  DispatchRequest,
  DispatchAuthorize,
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
  DispatchesGet,
} from "./dispatch.js";
import { MessagesAuthorize, TaskCreate } from "./app-callbacks.js";

export const appRpcMethods = [
  AppsRegister,
  DispatchRequest,
  DispatchesGet,
] as const;

export const appCallbackMethods = [
  DispatchAuthorize,
  MessagesAuthorize,
  TaskCreate,
] as const;

export const appNotifications = [
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
] as const;
