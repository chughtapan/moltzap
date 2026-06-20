/** @file Agent identity service tag and live layer. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";

import { AuthService } from "./auth.service.js";

export class AuthServiceTag extends Context.Tag("moltzap/AuthService")<
  AuthServiceTag,
  AuthService
>() {}

export const AuthServiceLive = Layer.effect(
  AuthServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new AuthService(db);
  }).pipe(Effect.withSpan("AuthServiceLive")),
);
