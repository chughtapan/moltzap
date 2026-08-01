import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerApp,
  connectAppClient,
  postJson,
  getBaseUrl,
  HTTP_BAD_REQUEST,
} from "../helpers.js";

import type { AppManifest } from "@moltzap/protocol/identity";

const APP_ID = "00000000-0000-4000-8000-000000010008";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("apps/register: HTTP registers a valid manifest and the app can connect", () =>
  Effect.gen(function* () {
    const manifest: AppManifest = {
      appId: APP_ID,
      name: "My Test App",
      hooks: {
        dispatch_authorize: { kind: "grant" },
        message_authorize: { kind: "forwardAllExceptSender" },
      },
    };

    const registered = yield* registerApp(getBaseUrl(), manifest);

    // The server mints its OWN `appId` (gen_random_uuid()), distinct from
    // the manifest's declared id.
    expect(registered.appId).not.toBe(APP_ID);

    // The minted `appKey` authenticates an `AppConnection` (implicit
    // moderator-endpoint registration) — proves the credential is live.
    yield* connectAppClient(registered.appId, registered.appKey);
  }));

it("apps/register: HTTP rejects a manifest missing required fields", () =>
  Effect.gen(function* () {
    // Post a structurally-invalid manifest directly (the typed `registerApp`
    // helper cannot express this) and assert the HTTP validation 400.
    const { status } = yield* postJson(getBaseUrl(), "/api/v1/apps/register", {
      manifest: { appId: "broken" },
    });
    expect(status).toBe(HTTP_BAD_REQUEST);
  }));

it("apps/register: HTTP rejects a request missing the manifest param", () =>
  Effect.gen(function* () {
    const { status } = yield* postJson(
      getBaseUrl(),
      "/api/v1/apps/register",
      {},
    );
    expect(status).toBe(HTTP_BAD_REQUEST);
  }));
