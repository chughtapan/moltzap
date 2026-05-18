import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vitest";
import { Effect, unsafeCoerce } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  endpointAddress,
  type EndpointAddress,
} from "@moltzap/protocol/network";
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

const liveIt = effectIt.live;

function privateField<T>(target: object, key: string): T {
  return Reflect.get(target, key) as T;
}

type HookRegistry = Map<
  string,
  {
    taskAuthorizeDispatch?: unknown;
  }
>;

type MessageAuthorizeRegistry = Map<EndpointAddress, unknown>;

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
    signal: new AbortController().signal,
  };
}

describe("AppHost.onTaskAuthorizeDispatch (registration surface)", () => {
  it("stores the handler keyed by appId", () => {
    const { host } = makeAppHost();
    const handler = () => ({ decision: "grant" as const });
    host.onTaskAuthorizeDispatch("my-app", handler);

    const hooks = privateField<HookRegistry>(host, "hooks");
    expect(hooks.get("my-app")?.taskAuthorizeDispatch).toBe(handler);
  });

  it("overwrites a prior handler for the same appId (last-writer-wins)", () => {
    const { host } = makeAppHost();
    const first = () => ({ decision: "grant" as const });
    const second = () => ({ decision: "deny" as const });
    host.onTaskAuthorizeDispatch("app-x", first);
    host.onTaskAuthorizeDispatch("app-x", second);

    const hooks = privateField<HookRegistry>(host, "hooks");
    expect(hooks.get("app-x")?.taskAuthorizeDispatch).toBe(second);
  });
});

describe("AppHost.registerMessageAuthorize", () => {
  it("stores the handler keyed by endpoint address", () => {
    const { host } = makeAppHost();
    const handler = () => ({ decision: "Forward" as const, recipients: [] });
    host.registerMessageAuthorize(TM_ADDRESS, handler);

    const hooks = privateField<MessageAuthorizeRegistry>(
      host,
      "messageAuthorizeHooks",
    );
    expect(hooks.get(TM_ADDRESS)).toBe(handler);
  });

  it("overwrites a prior handler for the same endpoint address", () => {
    const { host } = makeAppHost();
    const first = () => ({ decision: "Forward" as const, recipients: [] });
    const second = () => ({ decision: "Block" as const, reason: "policy" });
    host.registerMessageAuthorize(TM_ADDRESS, first);
    host.registerMessageAuthorize(TM_ADDRESS, second);

    const hooks = privateField<MessageAuthorizeRegistry>(
      host,
      "messageAuthorizeHooks",
    );
    expect(hooks.get(TM_ADDRESS)).toBe(second);
  });
});

describe("AppHost.runMessageAuthorize", () => {
  liveIt(
    "runs the in-process hook registered for the TM endpoint",
    inProcessMessageAuthorizeHook,
  );

  liveIt(
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
