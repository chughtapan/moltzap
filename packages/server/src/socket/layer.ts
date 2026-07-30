/** @file WebSocket connection service tags and live layer. */

import { Context, Layer } from "effect";

import { ConnectionManager, type Connection } from "./connection.js";

/** Implements connection tag. */
export class ConnectionTag extends Context.Tag("moltzap/Connection")<
  ConnectionTag,
  Connection
>() {}

/** Implements connection manager tag. */
export class ConnectionManagerTag extends Context.Tag(
  "moltzap/ConnectionManager",
)<ConnectionManagerTag, ConnectionManager>() {}

/** Provides the connection manager live runtime value. */
export const connectionManagerLive = Layer.sync(
  ConnectionManagerTag,
  () => new ConnectionManager(),
);
