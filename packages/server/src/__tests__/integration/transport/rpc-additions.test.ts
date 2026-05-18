import * as fc from "fast-check";
import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  setupAgentPair,
} from "../helpers.js";

import {
  AppsRegister,
  ConversationsCreate,
  MessagesSend,
  NetworkPing,
} from "@moltzap/protocol";

const NETWORK_PING_MAX_CLOCK_SKEW_MS = 60_000;
const PROPERTY_RUNS = 25;
const APP_ID = "my-test-app";
const QUESTION_TEXT = "question";
const ANSWER_TEXT = "answer";
const ORPHAN_REPLY_TEXT = "orphan";
const UNKNOWN_MESSAGE_ID = "00000000-0000-0000-0000-000000000000";
const ISO8601_UTC_MILLISECONDS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("property: recent timestamp predicate is bounded by configured skew", () =>
  Effect.sync(() => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: NETWORK_PING_MAX_CLOCK_SKEW_MS * 2 }),
        (ageMs) => {
          expect(isWithinPingSkew(ageMs)).toBe(
            ageMs < NETWORK_PING_MAX_CLOCK_SKEW_MS,
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  }));

it(`${NetworkPing.name}: returns an ISO8601 timestamp`, () =>
  Effect.gen(function* () {
    const agent = yield* registerAndConnect("alice");

    const result = (yield* agent.client.sendRpc(NetworkPing, {})) as {
      ts: string;
    };

    expect(result.ts).toEqual(expect.any(String));
    expect(result.ts).toMatch(ISO8601_UTC_MILLISECONDS_PATTERN);
    expect(isWithinPingSkew(Date.now() - Date.parse(result.ts))).toBe(true);
  }));

it(`${AppsRegister.name}: registers a valid manifest and returns the appId`, () =>
  Effect.gen(function* () {
    const agent = yield* registerAndConnect("alice");

    const result = (yield* agent.client.sendRpc(AppsRegister, {
      manifest: {
        appId: APP_ID,
        name: "My Test App",
        conversations: [
          { key: "main", name: "Main", participantFilter: "all" },
        ],
      },
    })) as { appId: string };

    expect(result.appId).toBe(APP_ID);
  }));

it(`${AppsRegister.name}: rejects a manifest missing required fields`, () =>
  Effect.gen(function* () {
    const agent = yield* registerAndConnect("alice");

    const exit = yield* Effect.exit(
      agent.client.sendRpc(AppsRegister, {
        manifest: { appId: "broken" },
      }),
    );
    expectExitFailure(exit);
  }));

it(`${AppsRegister.name}: rejects calls missing the manifest param`, () =>
  Effect.gen(function* () {
    const agent = yield* registerAndConnect("alice");

    const exit = yield* Effect.exit(agent.client.sendRpc(AppsRegister, {}));
    expectExitFailure(exit);
  }));

it("messages/send resolves conversationId from replyToId", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };
    const conversationId = conv.conversation.id;

    const sent = (yield* alice.client.sendRpc(MessagesSend, {
      conversationId,
      parts: [{ type: "text", text: QUESTION_TEXT }],
    })) as { message: { id: string } };

    const replied = (yield* bob.client.sendRpc(MessagesSend, {
      replyToId: sent.message.id,
      parts: [{ type: "text", text: ANSWER_TEXT }],
    })) as {
      message: { conversationId: string; replyToId?: string };
    };

    expect(replied.message.conversationId).toBe(conversationId);
    expect(replied.message.replyToId).toBe(sent.message.id);
  }));

it("messages/send rejects replyToId that points to an unknown message", () =>
  Effect.gen(function* () {
    const agent = yield* registerAndConnect("alice");

    const exit = yield* Effect.exit(
      agent.client.sendRpc(MessagesSend, {
        replyToId: UNKNOWN_MESSAGE_ID,
        parts: [{ type: "text", text: ORPHAN_REPLY_TEXT }],
      }),
    );
    expectExitFailure(exit);
  }));

function isWithinPingSkew(ageMs: number): boolean {
  return ageMs < NETWORK_PING_MAX_CLOCK_SKEW_MS;
}

function expectExitFailure<A, E>(exit: Exit.Exit<A, E>): void {
  expect(exit).toSatisfy(Exit.isFailure);
}
