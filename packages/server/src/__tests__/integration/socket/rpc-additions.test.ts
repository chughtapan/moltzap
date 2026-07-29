/* eslint-disable agent-code-guard/no-example-only-tests -- regression-only suite: each case names a specific live-server contract (HTTP apps/register manifest validation, agent/message/send replyToId threading + orphan rejection). These are scenario-shaped integration checks against the running server, not an input domain to generate over. */
import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
  registerApp,
  connectAppClient,
  postJson,
  getBaseUrl,
  HTTP_BAD_REQUEST,
} from "../helpers.js";

import {
  DEFAULT_APP_ID,
  taskCreate,
  taskRequest,
} from "@moltzap/protocol/task";
import { dispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { messagesAuthorize, messagesSend } from "@moltzap/protocol/message";
import type {
  AppCallbackContext,
  AppCallbackHandlers,
} from "@moltzap/protocol/socket";
import type { AppManifest } from "@moltzap/protocol/identity";
import { messageId } from "@moltzap/protocol/testing";

const APP_ID = "00000000-0000-4000-8000-000000010008";
const QUESTION_TEXT = "question";
const ANSWER_TEXT = "answer";
const ORPHAN_REPLY_TEXT = "orphan";
const UNKNOWN_MESSAGE_ID = messageId("00000000-0000-0000-0000-000000000000");

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

function unexpectedAppCallbacks(): AppCallbackHandlers<AppCallbackContext> {
  return {
    [dispatchAuthorize.name]: {
      definition: dispatchAuthorize,
      handle: () => Effect.dieMessage("unexpected app/dispatch/authorize"),
    },
    [messagesAuthorize.name]: {
      definition: messagesAuthorize,
      handle: () => Effect.dieMessage("unexpected app/message/authorize"),
    },
    [taskCreate.name]: {
      definition: taskCreate,
      handle: () => Effect.dieMessage("unexpected app/task/create"),
    },
  };
}

it("apps/register: HTTP registers a valid manifest and the app can connect", () =>
  Effect.gen(function* () {
    const manifest: AppManifest = {
      appId: APP_ID,
      name: "My Test App",
      conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
      hooks: {
        dispatch_authorize: { kind: "grant" },
        message_authorize: { kind: "forwardAllExceptSender" },
        task_create: { kind: "accept" },
      },
    };

    const registered = yield* registerApp(getBaseUrl(), manifest);

    // The server mints its OWN `appId` (gen_random_uuid()), distinct from
    // the manifest's declared id.
    expect(registered.appId).not.toBe(APP_ID);

    // The minted `appKey` authenticates an `AppConnection` (implicit
    // moderator-endpoint registration) — proves the credential is live.
    yield* connectAppClient(
      registered.appId,
      registered.appKey,
      unexpectedAppCallbacks(),
    );
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

it("agent/message/send preserves replyToId on the persisted message", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    const taskId = conv.task.id;
    const conversationId = conv.conversation!.id;

    const sent = yield* alice.client.sendRpc(messagesSend, {
      taskId,
      conversationId,
      parts: [{ type: "text", text: QUESTION_TEXT }],
    });

    const replied = yield* bob.client.sendRpc(messagesSend, {
      taskId,
      conversationId,
      replyToId: sent.message.id,
      parts: [{ type: "text", text: ANSWER_TEXT }],
    });

    expect(replied.message.conversationId).toBe(conversationId);
    expect(replied.message.replyToId).toBe(sent.message.id);
  }));

it("agent/message/send rejects replyToId that points to an unknown message", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });

    const exit = yield* Effect.exit(
      alice.client.sendRpc(messagesSend, {
        taskId: conv.task.id,
        conversationId: conv.conversation!.id,
        replyToId: UNKNOWN_MESSAGE_ID,
        parts: [{ type: "text", text: ORPHAN_REPLY_TEXT }],
      }),
    );
    expectExitFailure(exit);
  }));

function expectExitFailure<A, E>(exit: Exit.Exit<A, E>): void {
  expect(exit).toSatisfy(Exit.isFailure);
}
