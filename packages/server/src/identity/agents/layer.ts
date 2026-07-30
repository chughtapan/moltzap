/** @file Agent identity service tag and live layer. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";

import { AuthService } from "./auth.service.js";

/** Implements auth service tag. */
export class AuthServiceTag extends Context.Tag("moltzap/AuthService")<
  AuthServiceTag,
  AuthService
>() {}

/** Provides the auth service live runtime value. */
export const authServiceLive = Layer.effect(
  AuthServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new AuthService(db);
  }).pipe(Effect.withSpan("AuthServiceLive")),
);
