import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { ConnectionId } from "@moltzap/protocol/socket";
import type { AppManifest } from "@moltzap/protocol/identity";
import { DispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { MessagesAuthorize } from "@moltzap/protocol/message";
import { TaskCreate } from "@moltzap/protocol/task";
import { appId as makeAppId } from "@moltzap/protocol/testing";
import { AppEndpointRegistry } from "./endpoint-registry.js";
import { makeHandlerAppEndpoint } from "../../test-utils/app-endpoint.js";

const APP_ID = makeAppId("00000000-0000-4000-8000-000000000560");
const CONN_ID = Schema.decodeUnknownSync(ConnectionId)(
  "00000000-0000-4000-8000-00000000c001",
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

describe("AppEndpointRegistry.registerApp", () => {
  it("registers the app, keying the registration by the bound conn", () => {
    const registry = new AppEndpointRegistry();
    const connection = makeHandlerAppEndpoint({
      id: CONN_ID,
      handlers: {
        [DispatchAuthorize.name]: () =>
          Effect.succeed({ admission: { decision: "grant" } }),
        [MessagesAuthorize.name]: () =>
          Effect.succeed({
            verdict: {
              decision: "Forward",
              recipients: [],
            },
          }),
        [TaskCreate.name]: () =>
          Effect.succeed({ verdict: { decision: "accept" } }),
      },
    });
    registry.registerApp(APP_ID, APP_MANIFEST, connection);
    expect(registry.lookupApp(APP_ID)?.endpoint.connId).toBe(CONN_ID);
  });
});
