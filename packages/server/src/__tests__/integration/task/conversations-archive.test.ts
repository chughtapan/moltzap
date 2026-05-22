import * as fc from "fast-check";
import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  ForbiddenError,
  TaskConversationArchive,
  type TaskId,
} from "@moltzap/protocol";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentGroup,
} from "../helpers.js";
import type { ConnectedAgent } from "../helpers.js";
import { expectRpcFailure } from "../../../test-utils/index.js";

const PROPERTY_RUNS = 25;
const PERMISSION_GROUP_NAME = "Perm Test";

interface ListItem {
  readonly conversation: { readonly id: string; readonly archivedAt?: string };
}

function conversationStub(id: string): ListItem {
  return { conversation: { id } };
}

function hasConversation(
  items: ReadonlyArray<ListItem>,
  conversationId: string,
): boolean {
  return items.some((item) => item.conversation.id === conversationId);
}

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("property: conversation membership lookup follows listed IDs", () =>
  Effect.sync(() => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.array(fc.uuid(), { minLength: 0, maxLength: 8 }),
        (conversationId, ids) => {
          const items = ids.map(conversationStub);
          expect(hasConversation(items, conversationId)).toBe(
            ids.includes(conversationId),
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  }));

// TaskConversationArchive / Unarchive are TM-only (#677); DEFAULT_APP_ID
// tasks have no registered TM. Re-add positive coverage by rewriting
// the fixture to AppsRegister a moderator app.
it.todo("owner archives and unarchives; needs AppsRegister fixture");
it.todo("archive of archived conversation is idempotent");
it.todo("unarchive of active conversation is idempotent");
it.todo("archive of task-attached conversation succeeds for the owner");
it.todo("concurrent archive by the same privileged caller is idempotent");

it("non-owner/admin member gets 403 on archive", () =>
  Effect.gen(function* () {
    const group = yield* setupAgentGroup(2, {
      groupName: PERMISSION_GROUP_NAME,
    });
    const [, bob] = group.agents as [ConnectedAgent, ConnectedAgent];
    const taskId = group.taskId! as TaskId;
    const conversationId = group.conversationId!;

    const err = yield* expectRpcFailure(
      bob.client.sendRpc(TaskConversationArchive, { taskId, conversationId }),
      ForbiddenError.code,
    );
    expect(err.code).toBe(ForbiddenError.code);
  }));
