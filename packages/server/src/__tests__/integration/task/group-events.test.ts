import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentGroup,
} from "../helpers.js";
import type { ConnectedAgent } from "../helpers.js";

import {
  ConversationsCreate,
  ConversationCreatedNotificationDefinition,
} from "@moltzap/protocol";

const GROUP_TYPE = "group";
const GROUP_NAME = "Eval Group";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("group creation notifies all participants with conversations/created event", () =>
  Effect.gen(function* () {
    const { agents } = yield* setupAgentGroup(3);
    const [alice, bob, eve] = agents as [
      ConnectedAgent,
      ConnectedAgent,
      ConnectedAgent,
    ];

    // Set up event waiters on Bob and Eve BEFORE creating the group

    const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
      type: GROUP_TYPE,
      name: GROUP_NAME,
      participants: [
        { type: "agent", id: bob.agentId },
        { type: "agent", id: eve.agentId },
      ],
    })) as {
      conversation: { id: string; type: string; name: string };
    };

    expect(conv.conversation.type).toBe(GROUP_TYPE);
    expect(conv.conversation.name).toBe(GROUP_NAME);

    const bobCreated = yield* awaitOneNotification(
      bob.client,
      ConversationCreatedNotificationDefinition,
    );
    const eveCreated = yield* awaitOneNotification(
      eve.client,
      ConversationCreatedNotificationDefinition,
    );

    const bobConv = (bobCreated.params as { conversation: { id: string } })
      .conversation;
    const eveConv = (eveCreated.params as { conversation: { id: string } })
      .conversation;

    expect(bobConv.id).toBe(conv.conversation.id);
    expect(eveConv.id).toBe(conv.conversation.id);
  }));
