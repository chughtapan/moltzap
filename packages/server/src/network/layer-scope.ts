import { Context } from "effect";

export class NetworkLayerScope extends Context.Tag(
  "@moltzap/server/NetworkLayerScope",
)<NetworkLayerScope, { readonly _: "NetworkLayerScope" }>() {}
