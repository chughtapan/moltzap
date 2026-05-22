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
  DEFAULT_APP_ID,
  TaskConversationCreatedNotificationDefinition,
  TaskCreate,
} from "@moltzap/protocol";

const GROUP_NAME = "Eval Group";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("group creation notifies all participants with task/conversation/created event", () =>
  Effect.gen(function* () {
    const { agents } = yield* setupAgentGroup(3);
    const [alice, bob, eve] = agents as [
      ConnectedAgent,
      ConnectedAgent,
      ConnectedAgent,
    ];

    // Set up event waiters on Bob and Eve BEFORE creating the group

    const conv = yield* alice.client.sendRpc(TaskCreate, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId, eve.agentId],
      initialConversation: {
        name: GROUP_NAME,
        participants: [bob.agentId, eve.agentId],
      },
    });

    expect(conv.conversation!.name).toBe(GROUP_NAME);

    const bobCreated = yield* awaitOneNotification(
      bob.client,
      TaskConversationCreatedNotificationDefinition,
    );
    const eveCreated = yield* awaitOneNotification(
      eve.client,
      TaskConversationCreatedNotificationDefinition,
    );

    expect(bobCreated.params.conversationId).toBe(conv.conversation!.id);
    expect(eveCreated.params.conversationId).toBe(conv.conversation!.id);
  }));
