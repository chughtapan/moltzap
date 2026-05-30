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
  registerApp,
  connectAppClient,
  postJson,
  getBaseUrl,
  HTTP_BAD_REQUEST,
} from "../helpers.js";

import {
  DEFAULT_APP_ID,
  MessagesSend,
  NetworkPing,
  TaskRequest,
  type AppManifest,
} from "@moltzap/protocol";
import { messageId } from "@moltzap/protocol/testing";

const NETWORK_PING_MAX_CLOCK_SKEW_MS = 60_000;
const PROPERTY_RUNS = 25;
const APP_ID = "00000000-0000-4000-8000-000000010008";
const QUESTION_TEXT = "question";
const ANSWER_TEXT = "answer";
const ORPHAN_REPLY_TEXT = "orphan";
const UNKNOWN_MESSAGE_ID = messageId("00000000-0000-0000-0000-000000000000");
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

    const result = yield* agent.client.sendRpc(NetworkPing, {});

    expect(result.ts).toEqual(expect.any(String));
    expect(result.ts).toMatch(ISO8601_UTC_MILLISECONDS_PATTERN);
    expect(isWithinPingSkew(Date.now() - Date.parse(result.ts))).toBe(true);
  }));

// D #705 CP9 — app registration is the HTTP `/api/v1/apps/register`
// endpoint (server-minted `appId` + `appKey`); the app then `appKey`-
// Connects to bind its `AppConnection` as the moderator endpoint. There
// is no cross-principal WS `apps/register` RPC (an agent registering an
// app is the dissolved anti-pattern). These exercise the live HTTP
// boundary + the appKey-Connect arm.
it("apps/register: HTTP registers a valid manifest and the app can connect", () =>
  Effect.gen(function* () {
    const manifest: AppManifest = {
      appId: APP_ID,
      name: "My Test App",
      conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
    };

    const registered = yield* registerApp(getBaseUrl(), manifest);

    // The server mints its OWN `appId` (gen_random_uuid()), distinct from
    // the manifest's declared id, and a parseable `appKey`.
    expect(registered.appId).toEqual(expect.any(String));
    expect(registered.appId).not.toBe(APP_ID);
    expect(registered.appKey).toEqual(expect.any(String));

    // The minted `appKey` authenticates an `AppConnection` (implicit
    // moderator-endpoint registration) — proves the credential is live.
    yield* connectAppClient(registered.appKey);
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

it("messages/send preserves replyToId on the persisted message", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    const taskId = conv.task.id;
    const conversationId = conv.conversation!.id;

    const sent = yield* alice.client.sendRpc(MessagesSend, {
      taskId,
      conversationId,
      parts: [{ type: "text", text: QUESTION_TEXT }],
    });

    const replied = yield* bob.client.sendRpc(MessagesSend, {
      taskId,
      conversationId,
      replyToId: sent.message.id,
      parts: [{ type: "text", text: ANSWER_TEXT }],
    });

    expect(replied.message.conversationId).toBe(conversationId);
    expect(replied.message.replyToId).toBe(sent.message.id);
  }));

it("messages/send rejects replyToId that points to an unknown message", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });

    const exit = yield* Effect.exit(
      alice.client.sendRpc(MessagesSend, {
        taskId: conv.task.id,
        conversationId: conv.conversation!.id,
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
