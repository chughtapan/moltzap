/** @file App identity service tags and live layers. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";

import { AppAuthService } from "./auth.service.js";
import { AppEndpointRegistry } from "./endpoint-registry.js";

export class AppAuthServiceTag extends Context.Tag("moltzap/AppAuthService")<
  AppAuthServiceTag,
  AppAuthService
>() {}

export class AppEndpointRegistryTag extends Context.Tag(
  "moltzap/AppEndpointRegistry",
)<AppEndpointRegistryTag, AppEndpointRegistry>() {}

export const AppAuthServiceLive = Layer.effect(
  AppAuthServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new AppAuthService(db);
  }).pipe(Effect.withSpan("AppAuthServiceLive")),
);

export const AppEndpointRegistryLive = Layer.sync(
  AppEndpointRegistryTag,
  () => new AppEndpointRegistry(),
);
