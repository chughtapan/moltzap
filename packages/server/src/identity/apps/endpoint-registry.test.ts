import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { connectionIdSchema } from "@moltzap/protocol/socket";
import type { AppManifest } from "@moltzap/protocol/identity";
import { appId as makeAppId } from "@moltzap/protocol/testing";
import type { Originator } from "#socket";
import { AppEndpointRegistry } from "./endpoint-registry.js";
import type { AppEndpoint } from "./registry.js";

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
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "forwardAllExceptSender" },
  },
} satisfies AppManifest;

// Registry tests only exercise registration keying; the originator is
// never invoked, so every channel defects on use.
function makeTestEndpoint(id: typeof CONN_ID): AppEndpoint {
  const die = (op: string) =>
    Effect.die(new Error(`test endpoint: unexpected ${op}`));
  const originator: Originator = {
    call: () => die("call"),
    notify: () => die("notify"),
    sink: {
      parser: {
        decode: () => {
          throw new Error("test endpoint: unexpected sink.parser.decode");
        },
        encode: () => {
          throw new Error("test endpoint: unexpected sink.parser.encode");
        },
      },
      inject: () => die("sink.inject"),
    },
  };
  return { connId: id, originator };
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
