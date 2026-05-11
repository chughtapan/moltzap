import { Context } from "effect";

export class NetworkLayerScope extends Context.Tag(
  "@moltzap/server/NetworkLayerScope",
)<NetworkLayerScope, void>() {}

export class TaskLayerScope extends Context.Tag(
  "@moltzap/server/TaskLayerScope",
)<TaskLayerScope, void>() {}

export class AppLayerScope extends Context.Tag("@moltzap/server/AppLayerScope")<
  AppLayerScope,
  void
>() {}
