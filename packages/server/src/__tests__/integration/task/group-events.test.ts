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

import { DEFAULT_APP_ID, taskRequest } from "@moltzap/protocol/task";
import { conversationCreatedNotificationDefinition } from "@moltzap/protocol/conversation";

const GROUP_NAME = "Eval Group";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("group creation notifies all participants with app/conversation/created event", () =>
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

    const conv = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId, eve.agentId],
      initialConversation: {
        name: GROUP_NAME,
        participants: [bob.agentId, eve.agentId],
      },
    });

    expect(
      /* Safe because the test fixture establishes this asserted shape. */ conv
        .conversation!.name,
    ).toBe(GROUP_NAME);

    const bobCreated = yield* Fiber.join(bobCreatedFiber);
    const eveCreated = yield* Fiber.join(eveCreatedFiber);

    expect(bobCreated.params.conversationId).toBe(
      /* Safe because the test fixture establishes this asserted shape. */ conv
        .conversation!.id,
    );
    expect(eveCreated.params.conversationId).toBe(
      /* Safe because the test fixture establishes this asserted shape. */ conv
        .conversation!.id,
    );
  }));
