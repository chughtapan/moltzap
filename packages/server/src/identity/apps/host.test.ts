import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConnectionId } from "@moltzap/protocol/socket";
import type { AppManifest } from "@moltzap/protocol/identity";
import type { ParamsOf } from "@moltzap/protocol/transport";
import { DispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { MessagesAuthorize } from "@moltzap/protocol/message";
import { TaskCreate } from "@moltzap/protocol/task";
import {
  agentId,
  appId as makeAppId,
  conversationId,
  messageId,
  taskId,
} from "@moltzap/protocol/testing";
import type { Db } from "../../db/client.js";
import type { ConnectionManager } from "#socket";
import { makeFakeService } from "../../test-utils/fakes.js";
import { AppHost } from "./host.js";
import type { MessageAuthorizeContext } from "#core";
import { makeHandlerAppEndpoint } from "../../test-utils/app-endpoint.js";

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
const CONN_ID = Schema.decodeUnknownSync(ConnectionId)(
  "00000000-0000-4000-8000-00000000c001",
);
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-00000000c560");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-00000000e560");
const TASK_ID = taskId("00000000-0000-4000-8000-00000000a560");
const SENDER = agentId("00000000-0000-4000-8000-00000000b001");
const RECIPIENT = agentId("00000000-0000-4000-8000-00000000b002");

// Declares all three policies as `kind: "hook"` so the dispatch-path
// tests below round-trip to the registered connection's callback; a
// static policy would resolve in-process and never reach the handler.
const APP_MANIFEST = {
  appId: APP_ID,
  name: "test app",
  hooks: {
    dispatch_authorize: { kind: "hook", timeoutMs: 5_000 },
    message_authorize: { kind: "hook", timeoutMs: 5_000 },
    task_create: { kind: "hook", timeoutMs: 5_000 },
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
    const connection = makeHandlerAppEndpoint({
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
        [TaskCreate.name]: () =>
          Effect.succeed({ verdict: { decision: "accept" as const } }),
      },
    });
    host.registerApp(APP_ID, APP_MANIFEST, connection);
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
    const connection = makeHandlerAppEndpoint({
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
        [TaskCreate.name]: () =>
          Effect.succeed({ verdict: { decision: "accept" as const } }),
      },
    });
    host.registerApp(APP_ID, APP_MANIFEST, connection);
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
    expect(result).toEqual({ decision: "Block", reason: "app_unreachable" });
  });
}
