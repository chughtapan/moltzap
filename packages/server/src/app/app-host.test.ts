import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";

const it = effectIt.live;

import { Effect, unsafeCoerce } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import { endpointAddress } from "@moltzap/protocol/network";
import {
  agentId,
  conversationId,
  messageId,
  taskId,
} from "@moltzap/protocol/testing";
import type { Db } from "../db/client.js";
import type { ConnectionManager } from "../transport/connection.js";
import { makeFakeService } from "../test-utils/fakes.js";
import { AppHost } from "./app-host.js";
import type { MessageAuthorizeContext } from "./hooks.js";

function makeAppHost(db: Db = makeEmptyDb()): { host: AppHost } {
  const connections = makeFakeService<ConnectionManager>(
    {} as Partial<ConnectionManager>,
  );
  const host = new AppHost(db, connections);
  return { host };
}

function makeEmptyDb(): Db {
  return makeFakeService<Db>({} as Partial<Db>);
}

function makeParticipantDb(): Db {
  const selectFrom = unsafeCoerce<() => unknown, Db["selectFrom"]>(() => ({
    select: () => ({
      where: () =>
        Effect.succeed([{ agent_id: SENDER }, { agent_id: RECIPIENT }]),
    }),
  }));
  return makeFakeService<Db>({
    selectFrom,
  });
}

const TM_APP_ID = "00000000-0000-4000-8000-000000000560";
const TM_ADDRESS = endpointAddress(`tm:app:${TM_APP_ID}`);
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-00000000c560");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-00000000e560");
const TASK_ID = taskId("00000000-0000-4000-8000-00000000a560");
const SENDER = agentId("00000000-0000-4000-8000-00000000b001");
const RECIPIENT = agentId("00000000-0000-4000-8000-00000000b002");

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
    appId: TM_APP_ID,
    receivedAt: "2026-05-12T00:00:00.000Z",
  };
}

describe("AppHost.runMessageAuthorize", () => {
  it(
    "runs the in-process hook registered for the TM endpoint",
    inProcessMessageAuthorizeHook,
  );

  it(
    "defaults to participants minus sender when no hook is registered",
    defaultMessageAuthorizeRecipients,
  );
});

function inProcessMessageAuthorizeHook() {
  return Effect.gen(function* () {
    const { host } = makeAppHost();
    host.registerMessageAuthorize(TM_ADDRESS, (ctx) => ({
      decision: "Forward",
      recipients: ctx.message.senderAgentId === SENDER ? [RECIPIENT] : [SENDER],
    }));

    const result = yield* host.runMessageAuthorize(
      TM_ADDRESS,
      messageAuthorizeContext(),
    );
    expect(result).toEqual({ decision: "Forward", recipients: [RECIPIENT] });
  });
}

function defaultMessageAuthorizeRecipients() {
  return Effect.gen(function* () {
    const { host } = makeAppHost(makeParticipantDb());
    host.setConversationService({
      removeParticipant: () => Effect.void,
    });

    const result = yield* host.runMessageAuthorize(
      TM_ADDRESS,
      messageAuthorizeContext(),
    );
    expect(result).toEqual({ decision: "Forward", recipients: [RECIPIENT] });
  });
}
