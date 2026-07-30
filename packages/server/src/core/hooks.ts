/** @file Core app connection hook service tag. */

import { Context } from "effect";

import type { ConnectionHook, DisconnectionHook } from "./types.js";

/** Describes connection hooks. */
export interface ConnectionHooks {
  readonly connectionHooks: readonly ConnectionHook[];
  readonly disconnectionHooks: readonly DisconnectionHook[];
}

/** Implements connection hooks tag. */
export class ConnectionHooksTag extends Context.Tag("moltzap/ConnectionHooks")<
  ConnectionHooksTag,
  ConnectionHooks
>() {}
