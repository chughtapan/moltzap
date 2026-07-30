/** @file Presence service tag and live layer. */
// safer-arch-ignore folder-explicit-api-required: Presence layer is the explicit runtime facade used by the connection adapter and composition root.

import { Context, Effect, Layer } from "effect";

import { PresenceService } from "./presence.service.js";

/** Implements presence service tag. */
export class PresenceServiceTag extends Context.Tag("moltzap/PresenceService")<
  PresenceServiceTag,
  PresenceService
>() {}

/** Provides the presence service live runtime value. */
export const presenceServiceLive: Layer.Layer<PresenceServiceTag> =
  Layer.effect(
    PresenceServiceTag,
    PresenceService.make().pipe(Effect.withSpan("PresenceServiceLive")),
  );
