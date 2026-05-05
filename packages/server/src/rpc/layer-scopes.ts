import { Context } from "effect";

export class NetworkLayerScope extends Context.Tag(
  "@moltzap/server/NetworkLayerScope",
)<NetworkLayerScope, { readonly _: "NetworkLayerScope" }>() {}

export class TaskLayerScope extends Context.Tag(
  "@moltzap/server/TaskLayerScope",
)<TaskLayerScope, { readonly _: "TaskLayerScope" }>() {}

export class AppLayerScope extends Context.Tag("@moltzap/server/AppLayerScope")<
  AppLayerScope,
  { readonly _: "AppLayerScope" }
>() {}

export const LAYERS = ["network", "task", "app"] as const;
export type Layer = (typeof LAYERS)[number];

export const NETWORK_SCOPE: { readonly _: "NetworkLayerScope" } = {
  _: "NetworkLayerScope",
};
export const TASK_SCOPE: { readonly _: "TaskLayerScope" } = {
  _: "TaskLayerScope",
};
export const APP_SCOPE: { readonly _: "AppLayerScope" } = {
  _: "AppLayerScope",
};
