/**
 * @file App reverse-callback handler table for protocol app clients.
 */

import type { Effect } from "effect";
import type { appCallbackMethods } from "../rpc-method-groups.js";
import type {
  ParamsOf,
  ResultOf,
  RpcDefinition,
  RpcDefinitionAny,
} from "../transport/method.js";

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
