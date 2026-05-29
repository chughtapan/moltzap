import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConnectionId } from "@moltzap/protocol/network";
import type { AppManifest, ParamsOf } from "@moltzap/protocol";
import { DispatchAuthorize, MessagesAuthorize } from "@moltzap/protocol";
import {
  agentId,
  appId as makeAppId,
  conversationId,
  messageId,
  taskId,
} from "@moltzap/protocol/testing";
import { Value } from "@sinclair/typebox/value";
import type { Db } from "../db/client.js";
import type { ConnectionManager } from "../transport/connection.js";
import { makeFakeService } from "../test-utils/fakes.js";
import { AppHost } from "./app-host.js";
import type { MessageAuthorizeContext } from "./types.js";
import { makeLoopbackConnection } from "./loopback-connection.js";

const liveIt = effectIt.live;

function makeAppHost(): { host: AppHost } {
  const connections = makeFakeService<ConnectionManager>(
    {} as Partial<ConnectionManager>,
  );
  const db = makeFakeService<Db>({} as Partial<Db>);
  const host = new AppHost(db, connections);
  return { host };
}

const APP_ID = makeAppId("00000000-0000-4000-8000-000000000560");
const OTHER_APP_ID = makeAppId("00000000-0000-4000-8000-000000000999");
const CONN_ID = Value.Decode(
  ConnectionId,
  "00000000-0000-4000-8000-00000000c001",
);
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-00000000c560");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-00000000e560");
const TASK_ID = taskId("00000000-0000-4000-8000-00000000a560");
const SENDER = agentId("00000000-0000-4000-8000-00000000b001");
const RECIPIENT = agentId("00000000-0000-4000-8000-00000000b002");

// Declares all three hooks so the dispatch-path tests below opt INTO
// the app round-trip. D #705 CP8 added a manifest-default fast-path:
// a manifest that OMITS a hook is served the synthetic default
// server-side (no app dispatch), so a hookless manifest would never
// reach the registered connection's callback.
const APP_MANIFEST = {
  appId: APP_ID,
  name: "test app",
  hooks: {
    dispatch_authorize: {},
    message_authorize: {},
    task_create: {},
  },
} satisfies AppManifest;

function messageAuthorizeContext(
  senderAgentId: AgentId = SENDER,
): MessageAuthorizeContext {
  return {
    conversationId: CONVERSATION_ID,
    message: {
      id: MESSAGE_ID,
      senderAgentId,
      parts: [{ type: "text", text: "hello" }],
    },
    taskId: TASK_ID,
    appId: APP_ID,
    receivedAt: "2026-05-12T00:00:00.000Z",
  };
}

describe("AppHost.registerApp", () => {
  it("registers the app, keying the registration by the bound conn", () => {
    const { host } = makeAppHost();
    const connection = makeLoopbackConnection({
      id: CONN_ID,
      handlers: {
        [DispatchAuthorize.name]: () =>
          Effect.succeed({ admission: { decision: "grant" as const } }),
        [MessagesAuthorize.name]: () =>
          Effect.succeed({
            verdict: {
              decision: "Forward" as const,
              recipients: [] as ReadonlyArray<AgentId>,
            },
          }),
      },
    });
    host.registerApp(APP_MANIFEST, connection);
    expect(host.lookupApp(APP_ID)?.endpoint.connId).toBe(CONN_ID);
  });
});

describe("AppHost.runMessageAuthorize", () => {
  liveIt(
    "dispatches via the registered app's connection",
    runRegisteredMessageAuthorize,
  );
  liveIt(
    "fail-closes to Block when no app is registered",
    unknownAppFailsClosed,
  );
});

function runRegisteredMessageAuthorize() {
  return Effect.gen(function* () {
    const { host } = makeAppHost();
    const connection = makeLoopbackConnection({
      id: CONN_ID,
      handlers: {
        [DispatchAuthorize.name]: () =>
          Effect.succeed({ admission: { decision: "grant" as const } }),
        [MessagesAuthorize.name]: (
          params: ParamsOf<typeof MessagesAuthorize>,
        ) =>
          Effect.succeed({
            verdict: {
              decision: "Forward" as const,
              recipients:
                params.message.senderAgentId === SENDER
                  ? [RECIPIENT]
                  : [SENDER],
            },
          }),
      },
    });
    host.registerApp(APP_MANIFEST, connection);
    const result = yield* host.runMessageAuthorize(
      APP_ID,
      messageAuthorizeContext(),
    );
    expect(result).toEqual({ decision: "Forward", recipients: [RECIPIENT] });
  });
}

function unknownAppFailsClosed() {
  return Effect.gen(function* () {
    const { host } = makeAppHost();
    const result = yield* host.runMessageAuthorize(
      OTHER_APP_ID,
      messageAuthorizeContext(),
    );
    expect(result).toEqual({ decision: "Block", reason: "tm_unreachable" });
  });
}
