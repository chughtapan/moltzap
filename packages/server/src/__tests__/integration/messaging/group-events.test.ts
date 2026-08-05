import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Fiber } from "effect";
import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentGroup,
  type ConnectedAgent,
} from "../helpers.js";

import {
  agentConversationCreate,
  conversationCreatedNotificationDefinition,
} from "@moltzap/protocol/conversation";

const GROUP_NAME = "Eval Group";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("group creation notifies all participants with agent/conversation/created event", () =>
  Effect.gen(function* () {
    const { agents } = yield* setupAgentGroup(3);
    const [alice, bob, eve] =
      /* Safe because the test fixture establishes this asserted shape. */ agents as [
        ConnectedAgent,
        ConnectedAgent,
        ConnectedAgent,
      ];

    const bobCreatedFiber = yield* Effect.fork(
      awaitOneNotification(
        bob.client,
        conversationCreatedNotificationDefinition,
      ),
    );
    const eveCreatedFiber = yield* Effect.fork(
      awaitOneNotification(
        eve.client,
        conversationCreatedNotificationDefinition,
      ),
    );

    const conv = yield* alice.client.sendRpc(agentConversationCreate, {
      name: GROUP_NAME,
      participants: [bob.agentId, eve.agentId],
    });

    expect(conv.conversation.name).toBe(GROUP_NAME);

    const bobCreated = yield* Fiber.join(bobCreatedFiber);
    const eveCreated = yield* Fiber.join(eveCreatedFiber);

    expect(bobCreated.params.conversationId).toBe(conv.conversation.id);
    expect(eveCreated.params.conversationId).toBe(conv.conversation.id);
  }));
