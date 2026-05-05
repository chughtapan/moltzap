import { Context } from "effect";

export class TaskLayerScope extends Context.Tag(
  "@moltzap/server/TaskLayerScope",
)<TaskLayerScope, { readonly _: "TaskLayerScope" }>() {}
