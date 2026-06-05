/**
 * @file App-domain RPC descriptors and the app-callback handler table.
 *
 * The app domain authors the app-callable c2s methods, the agent-callable
 * app-mediated methods, the server→app callback catalog, and the notification
 * descriptors. The engine consumes these catalogs to build concrete RPC groups.
 */
import type { Effect } from "effect";

import type {
  ParamsOf,
  ResultOf,
  RpcDefinition,
  RpcDefinitionAny,
} from "../transport/method.js";

export { validateAppManifest } from "./manifest.js";
export type { AppManifest } from "./manifest.js";

export { MessagesAuthorize, TaskCreate } from "./app-callbacks.js";

import { DispatchAuthorize } from "../dispatch/index.js";
import { MessagesAuthorize, TaskCreate } from "./app-callbacks.js";

export const appCallbackMethods = [
  DispatchAuthorize,
  MessagesAuthorize,
  TaskCreate,
] as const;

type AppCallbackDescriptor = RpcDefinitionAny;

/**
 * Per-definition app-callback handler slot. `Ctx` is the per-frame context the
 * client hands every handler.
 */
export interface HandlerSlot<D extends AppCallbackDescriptor, Ctx> {
  readonly definition: D;
  readonly handle: (
    params: ParamsOf<D>,
    ctx: Ctx,
  ) => Effect.Effect<ResultOf<D>, unknown>;
}

type NameOf<D> =
  D extends RpcDefinition<infer N, any, any, any, any> ? N : never;

type SlotValue<D, Ctx> = D extends AppCallbackDescriptor
  ? HandlerSlot<D, Ctx>
  : never;

type HandlerTable<Defs extends AppCallbackDescriptor, Ctx> = {
  readonly [D in Defs as NameOf<D>]: SlotValue<D, Ctx>;
};

export type AppCallbackRpcDefinition = (typeof appCallbackMethods)[number];

/**
 * Closed handler table for an app moderating one or more tasks. Every
 * `appCallbackMethods` member is required; vacuous-deny moderators still write
 * the handler explicitly.
 */
export type AppCallbackHandlers<Ctx> = HandlerTable<
  AppCallbackRpcDefinition,
  Ctx
>;
