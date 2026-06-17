/** @file Core app connection hook service tag. */

import { Context } from "effect";

import type { ConnectionHook, DisconnectionHook } from "./types.js";

export interface ConnectionHooks {
  readonly connectionHooks: readonly ConnectionHook[];
  readonly disconnectionHooks: readonly DisconnectionHook[];
}

export class ConnectionHooksTag extends Context.Tag("moltzap/ConnectionHooks")<
  ConnectionHooksTag,
  ConnectionHooks
>() {}
