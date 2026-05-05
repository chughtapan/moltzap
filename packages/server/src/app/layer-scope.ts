import { Context } from "effect";

export class AppLayerScope extends Context.Tag("@moltzap/server/AppLayerScope")<
  AppLayerScope,
  { readonly _: "AppLayerScope" }
>() {}
