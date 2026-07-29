import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import { connectionIdSchema } from "@moltzap/protocol/socket";
import type { AppManifest } from "@moltzap/protocol/identity";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import { dispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { messagesAuthorize } from "@moltzap/protocol/message";
import { taskCreate } from "@moltzap/protocol/task";
import {
  agentId,
  appId as makeAppId,
  conversationId,
  messageId,
  taskId,
} from "@moltzap/protocol/testing";
import { AppEndpointRegistry } from "#identity/apps";
import { makeFakeService } from "../test-utils/fakes.js";
import { makeHandlerAppEndpoint } from "../test-utils/app-endpoint.js";
import {
  type MessageAuthorizationConversations,
  MessageAuthorizationService,
  type MessageAuthorizeContext,
} from "./authorization.js";

const liveIt = effectIt.live;

const APP_ID = makeAppId("00000000-0000-4000-8000-000000000560");
const OTHER_APP_ID = makeAppId("00000000-0000-4000-8000-000000000999");
const CONN_ID = Schema.decodeUnknownSync(connectionIdSchema)(
  "00000000-0000-4000-8000-00000000c001",
);
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-00000000c560");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-00000000e560");
const TASK_ID = taskId("00000000-0000-4000-8000-00000000a560");
const SENDER = agentId("00000000-0000-4000-8000-00000000b001");
const RECIPIENT = agentId("00000000-0000-4000-8000-00000000b002");

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

function makeAuthorizationService(): {
  readonly registry: AppEndpointRegistry;
  readonly authorization: MessageAuthorizationService;
} {
  const registry = new AppEndpointRegistry();
  const conversations = makeFakeService<MessageAuthorizationConversations>({
    getParticipantAgentIds: () => Effect.succeed([SENDER, RECIPIENT]),
  });
  return {
    registry,
    authorization: new MessageAuthorizationService(registry, conversations),
  };
}

describe("MessageAuthorizationService", () => {
  it("forwards all participants except the sender for static policy", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { registry, authorization } = makeAuthorizationService();
        registry.registerApp(
          APP_ID,
          {
            ...APP_MANIFEST,
            hooks: {
              ...APP_MANIFEST.hooks,
              message_authorize: { kind: "forwardAllExceptSender" },
            },
          },
          makeHandlerAppEndpoint({
            id: CONN_ID,
            handlers: {
              [dispatchAuthorize.name]: () =>
                Effect.succeed({ admission: { decision: "grant" } }),
              [messagesAuthorize.name]: () =>
                Effect.succeed({
                  verdict: {
                    decision: "Block",
                    reason: "unexpected_hook",
                  },
                }),
              [taskCreate.name]: () =>
                Effect.succeed({ verdict: { decision: "accept" } }),
            },
          }),
        );
        const result = yield* authorization.authorize(
          APP_ID,
          messageAuthorizeContext(),
        );
        expect(result).toEqual({
          decision: "Forward",
          recipients: [RECIPIENT],
        });
      }),
    ));

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
    const { registry, authorization } = makeAuthorizationService();
    const connection = makeHandlerAppEndpoint({
      id: CONN_ID,
      handlers: {
        [dispatchAuthorize.name]: () =>
          Effect.succeed({ admission: { decision: "grant" } }),
        [messagesAuthorize.name]: (
          params: ParamsOf<typeof messagesAuthorize>,
        ) =>
          Effect.succeed({
            verdict: {
              decision: "Forward",
              recipients:
                params.message.senderAgentId === SENDER
                  ? [RECIPIENT]
                  : [SENDER],
            },
          }),
        [taskCreate.name]: () =>
          Effect.succeed({ verdict: { decision: "accept" } }),
      },
    });
    registry.registerApp(APP_ID, APP_MANIFEST, connection);
    const result = yield* authorization.authorize(
      APP_ID,
      messageAuthorizeContext(),
    );
    expect(result).toEqual({ decision: "Forward", recipients: [RECIPIENT] });
  });
}

function unknownAppFailsClosed() {
  return Effect.gen(function* () {
    const { authorization } = makeAuthorizationService();
    const result = yield* authorization.authorize(
      OTHER_APP_ID,
      messageAuthorizeContext(),
    );
    expect(result).toEqual({ decision: "Block", reason: "app_unreachable" });
  });
}
