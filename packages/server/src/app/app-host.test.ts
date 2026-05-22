import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vitest";
import { Effect, unsafeCoerce } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { AppManifest } from "@moltzap/protocol";
import {
  agentId,
  appId as makeAppId,
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

const APP_ID = makeAppId("00000000-0000-4000-8000-000000000560");
const OTHER_APP_ID = makeAppId("00000000-0000-4000-8000-000000000999");
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-00000000c560");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-00000000e560");
const TASK_ID = taskId("00000000-0000-4000-8000-00000000a560");
const SENDER = agentId("00000000-0000-4000-8000-00000000b001");
const RECIPIENT = agentId("00000000-0000-4000-8000-00000000b002");

const APP_MANIFEST = { appId: APP_ID, name: "test app" } satisfies AppManifest;
const OTHER_APP_MANIFEST = {
  appId: OTHER_APP_ID,
  name: "other test app",
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
    signal: new AbortController().signal,
  };
}

describe("AppHost.installInProcessApp (registration surface)", () => {
  it("bundles manifest + dispatch hook in one registration", () => {
    const { host } = makeAppHost();
    const handler = () => ({ decision: "grant" as const });
    host.installInProcessApp(APP_MANIFEST, { dispatchAuthorize: handler });
    expect(host.getManifest(APP_ID)).toBe(APP_MANIFEST);
  });

  it("re-install overwrites the prior registration (last-writer-wins)", () => {
    const { host } = makeAppHost();
    const first = () => ({ decision: "grant" as const });
    const second = () => ({ decision: "deny" as const });
    host.installInProcessApp(OTHER_APP_MANIFEST, { dispatchAuthorize: first });
    host.installInProcessApp(OTHER_APP_MANIFEST, { dispatchAuthorize: second });
    // Manifest is the same instance; behavioural assertion of the
    // overwritten dispatch hook lives in `runMessageAuthorize` /
    // dispatch-flow integration tests.
    expect(host.getManifest(OTHER_APP_ID)).toBe(OTHER_APP_MANIFEST);
  });
});

describe("AppHost.runMessageAuthorize", () => {
  liveIt(
    "runs the in-process hook bundled with the InProcess registration",
    inProcessMessageAuthorizeHook,
  );

  liveIt(
    "defaults to participants minus sender when no hook is registered",
    defaultMessageAuthorizeRecipients,
  );

  liveIt(
    "no-hook fallback ignores unknown appId without crashing",
    defaultMessageAuthorizeForUnknownApp,
  );
});

function inProcessMessageAuthorizeHook() {
  return Effect.gen(function* () {
    const { host } = makeAppHost();
    host.installInProcessApp(APP_MANIFEST, {
      dispatchAuthorize: () => ({ decision: "grant" as const }),
      messageAuthorize: (ctx) => ({
        decision: "Forward",
        recipients:
          ctx.message.senderAgentId === SENDER ? [RECIPIENT] : [SENDER],
      }),
    });

    const result = yield* host.runMessageAuthorize(
      APP_ID,
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
      APP_ID,
      messageAuthorizeContext(),
    );
    expect(result).toEqual({ decision: "Forward", recipients: [RECIPIENT] });
  });
}

function defaultMessageAuthorizeForUnknownApp() {
  return Effect.gen(function* () {
    const { host } = makeAppHost(makeParticipantDb());
    const result = yield* host.runMessageAuthorize(
      OTHER_APP_ID,
      messageAuthorizeContext(),
    );
    expect(result).toEqual({ decision: "Forward", recipients: [RECIPIENT] });
  });
}
