/** @file WebSocket connection service tags and live layer. */

import { Context, Layer } from "effect";

import { ConnectionManager, type Connection } from "./connection.js";

export class ConnectionTag extends Context.Tag("moltzap/Connection")<
  ConnectionTag,
  Connection
>() {}

export class ConnectionManagerTag extends Context.Tag(
  "moltzap/ConnectionManager",
)<ConnectionManagerTag, ConnectionManager>() {}

export const ConnectionManagerLive = Layer.sync(
  ConnectionManagerTag,
  () => new ConnectionManager(),
);
