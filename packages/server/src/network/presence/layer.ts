/** @file Presence service tag and live layer. */

import { Context, Effect, Layer } from "effect";

import { PresenceService } from "./presence.service.js";

export class PresenceServiceTag extends Context.Tag("moltzap/PresenceService")<
  PresenceServiceTag,
  PresenceService
>() {}

export const PresenceServiceLive: Layer.Layer<
  PresenceServiceTag,
  never,
  never
> = Layer.effect(
  PresenceServiceTag,
  Effect.gen(function* () {
    return yield* PresenceService.make();
  }).pipe(Effect.withSpan("PresenceServiceLive")),
);
