import { Context } from "effect";
import { ConnectionManager } from "../ws/connection.js";

export class ConnectionManagerTag extends Context.Tag("ConnectionManager")<
  ConnectionManagerTag,
  ConnectionManager
>() {}
