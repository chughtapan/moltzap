import { Context } from "effect";
import { Broadcaster as BroadcasterImpl } from "../ws/broadcaster.js";

export class BroadcasterTag extends Context.Tag("Broadcaster")<
  BroadcasterTag,
  BroadcasterImpl
>() {}
