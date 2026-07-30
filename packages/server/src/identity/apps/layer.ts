/** @file App identity service tags and live layers. */
// safer-arch-ignore file-implicit-boundary-module: This module deliberately owns the app identity tags and live-layer composition used by server assembly.

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";

import { AppAuthService } from "./auth.service.js";
import { AppEndpointRegistry } from "./endpoint-registry.js";

/** Implements app auth service tag. */
export class AppAuthServiceTag extends Context.Tag("moltzap/AppAuthService")<
  AppAuthServiceTag,
  AppAuthService
>() {}

/** Implements app endpoint registry tag. */
export class AppEndpointRegistryTag extends Context.Tag(
  "moltzap/AppEndpointRegistry",
)<AppEndpointRegistryTag, AppEndpointRegistry>() {}

/** Provides the app auth service live runtime value. */
export const appAuthServiceLive = Layer.effect(
  AppAuthServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new AppAuthService(db);
  }).pipe(Effect.withSpan("AppAuthServiceLive")),
);

/** Provides the app endpoint registry live runtime value. */
export const appEndpointRegistryLive = Layer.sync(
  AppEndpointRegistryTag,
  () => new AppEndpointRegistry(),
);
