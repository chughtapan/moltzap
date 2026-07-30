import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { connectionIdSchema } from "@moltzap/protocol/socket";
import type { AppManifest } from "@moltzap/protocol/identity";
import { dispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { messagesAuthorize } from "@moltzap/protocol/message";
import { taskCreate } from "@moltzap/protocol/task";
import { appId as makeAppId } from "@moltzap/protocol/testing";
import { AppEndpointRegistry } from "./endpoint-registry.js";
import { makeHandlerAppEndpoint } from "../../test-utils/app-endpoint.js";

const APP_ID = makeAppId("00000000-0000-4000-8000-000000000560");
const CONN_ID = Schema.decodeUnknownSync(connectionIdSchema)(
  "00000000-0000-4000-8000-00000000c001",
);
const OTHER_CONN_ID = Schema.decodeUnknownSync(connectionIdSchema)(
  "00000000-0000-4000-8000-00000000c002",
);

const APP_MANIFEST = {
  appId: APP_ID,
  name: "test app",
  hooks: {
    dispatch_authorize: { kind: "hook", timeoutMs: 5_000 },
    message_authorize: { kind: "hook", timeoutMs: 5_000 },
    task_create: { kind: "hook", timeoutMs: 5_000 },
  },
} satisfies AppManifest;

function makeTestEndpoint(id: typeof CONN_ID) {
  return makeHandlerAppEndpoint({
    id,
    handlers: {
      [dispatchAuthorize.name]: () =>
        Effect.succeed({ admission: { decision: "grant" } }),
      [messagesAuthorize.name]: () =>
        Effect.succeed({
          verdict: {
            decision: "Forward",
            recipients: [],
          },
        }),
      [taskCreate.name]: () =>
        Effect.succeed({ verdict: { decision: "accept" } }),
    },
  });
}

describe("AppEndpointRegistry.registerApp", () => {
  it("registers the app, keying the registration by the bound conn", () => {
    const registry = new AppEndpointRegistry();
    const connection = makeTestEndpoint(CONN_ID);
    registry.registerApp(APP_ID, APP_MANIFEST, connection);
    expect(registry.lookupApp(APP_ID)?.endpoint.connId).toBe(CONN_ID);
  });

  it("does not replace a live app registration", () => {
    const registry = new AppEndpointRegistry();
    const original = makeTestEndpoint(CONN_ID);
    const replacement = makeTestEndpoint(OTHER_CONN_ID);

    expect(registry.registerApp(APP_ID, APP_MANIFEST, original)).toBe(true);
    expect(registry.registerApp(APP_ID, APP_MANIFEST, replacement)).toBe(false);
    expect(registry.lookupApp(APP_ID)?.endpoint).toBe(original);
  });
});
