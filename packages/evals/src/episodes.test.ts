import { assert, effect as test } from "@effect/vitest";
import type { MessageId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  agentId,
  conversationId,
  messageId,
  taskId,
} from "@moltzap/protocol/testing";
import { Network, NetworkFailure } from "@moltzap/simulator";
import {
  makeAgentHandle,
  makeEndpoint,
  makeParticipantHandle,
  networkFailure,
  type EndpointInbox,
  type EndpointTransport,
  type NetworkService,
  type ReceivedMessage,
} from "@moltzap/simulator/network";
import { Effect, Stream } from "effect";
import {
  PROBE_SENDER_NAME,
  SENDER_NAME,
  crossConversationEpisode,
  directMultiTurnEpisode,
  speakingGroupEpisode,
} from "./episodes.js";

const TARGET_ID = agentId("00000000-0000-4000-8000-000000000001");
const SENDER_ID = agentId("00000000-0000-4000-8000-000000000002");
const BYSTANDER_ID = agentId("00000000-0000-4000-8000-000000000003");
const PROBE_ID = agentId("00000000-0000-4000-8000-000000000011");
const TASK_ID = taskId("00000000-0000-4000-8000-000000000004");
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000005");
const PROBE_CONVERSATION_ID = conversationId(
  "00000000-0000-4000-8000-000000000012",
);
const TARGET_RESPONSE_ID = messageId("00000000-0000-4000-8000-000000000006");
const BYSTANDER_MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000007");
const SENDER_MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000008");
const UNSOLICITED_RESPONSE_ID = messageId(
  "00000000-0000-4000-8000-000000000009",
);
const UNCORRELATED_RESPONSE_ID = messageId(
  "00000000-0000-4000-8000-000000000010",
);
const PROBE_RESPONSE_ID = messageId("00000000-0000-4000-8000-000000000013");
const SECOND_RESPONSE_ID = messageId("00000000-0000-4000-8000-000000000014");
const THIRD_RESPONSE_ID = messageId("00000000-0000-4000-8000-000000000015");
const MISSING_REPLY_DETAIL = "has no replyToId";
const RECEIVE_OPERATION = "receive";

interface SentMessage {
  readonly sender: string;
  readonly text: string;
}

function targetResponse(
  id: MessageId,
  text: string,
  replyToId?: MessageId,
): ReceivedMessage {
  return {
    taskId: TASK_ID,
    message: {
      id,
      conversationId: CONVERSATION_ID,
      senderId: TARGET_ID,
      ...(replyToId === undefined ? {} : { replyToId }),
      parts: [{ type: "text", text }],
      createdAt: "2026-07-29T00:00:00.000Z",
    },
  };
}

function inbox(
  sender: boolean,
  deliveries: ReadonlyArray<ReceivedMessage>,
): EndpointInbox {
  if (!sender) {
    return {
      messages: Stream.empty,
      conversation: () =>
        Effect.succeed(
          Stream.fail(
            networkFailure(
              "receive",
              "the setup endpoint must not await a target reply",
            ),
          ),
        ),
    };
  }
  let nextDelivery = 0;
  return {
    messages: Stream.empty,
    conversation: () =>
      Effect.succeed(
        Stream.fromEffect(
          Effect.suspend(() => {
            const delivery = deliveries[nextDelivery];
            nextDelivery += 1;
            return delivery === undefined
              ? Effect.fail(
                  networkFailure(
                    "receive",
                    "the graded response stream is exhausted",
                  ),
                )
              : Effect.succeed(delivery);
          }),
        ),
      ),
  };
}

function transport(
  sender: string,
  senderId: AgentId,
  sent: Array<SentMessage>,
): EndpointTransport {
  return {
    received: Stream.empty,
    openConversation: () =>
      Effect.succeed({
        taskId: TASK_ID,
        conversationId: CONVERSATION_ID,
      }),
    send: (_taskId, currentConversationId, parts) =>
      Effect.sync(() => {
        sent.push({
          sender,
          text: parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        });
        return {
          id: sender === SENDER_NAME ? SENDER_MESSAGE_ID : BYSTANDER_MESSAGE_ID,
          conversationId: currentConversationId,
          senderId,
          parts,
          createdAt: "2026-07-29T00:00:00.000Z",
        };
      }),
  };
}

function network(
  sent: Array<SentMessage>,
  deliveries: ReadonlyArray<ReceivedMessage>,
): NetworkService {
  return {
    endpoint<const Name extends string>(name: Name) {
      const isSender = name === SENDER_NAME;
      const endpointId = isSender ? SENDER_ID : BYSTANDER_ID;
      return Effect.succeed(
        makeEndpoint(
          {
            participant: makeParticipantHandle(name, endpointId),
            transport: transport(name, endpointId, sent),
          },
          inbox(isSender, deliveries),
        ),
      );
    },
  };
}

function crossConversationNetwork(): NetworkService {
  return {
    endpoint<const Name extends string>(name: Name) {
      const probe = name === PROBE_SENDER_NAME;
      const endpointId = probe ? PROBE_ID : SENDER_ID;
      const currentConversationId = probe
        ? PROBE_CONVERSATION_ID
        : CONVERSATION_ID;
      const responseId = probe ? PROBE_RESPONSE_ID : TARGET_RESPONSE_ID;
      return Effect.succeed(
        makeEndpoint(
          {
            participant: makeParticipantHandle(name, endpointId),
            transport: {
              received: Stream.empty,
              openConversation: () =>
                Effect.succeed({
                  taskId: TASK_ID,
                  conversationId: currentConversationId,
                }),
              send: (_taskId, conversationId, parts) =>
                Effect.succeed({
                  id: probe ? SENDER_MESSAGE_ID : BYSTANDER_MESSAGE_ID,
                  conversationId,
                  senderId: endpointId,
                  parts,
                  createdAt: "2026-07-29T00:00:00.000Z",
                }),
            },
          },
          inbox(true, [
            {
              taskId: TASK_ID,
              message: {
                id: responseId,
                conversationId: currentConversationId,
                senderId: TARGET_ID,
                parts: [{ type: "text", text: "target response" }],
                createdAt: "2026-07-29T00:00:00.000Z",
              },
            },
          ]),
        ),
      );
    },
  };
}

// @agent-code-guard/regression-only: a failing setup receive proves group setup cannot gate the graded prompt
test("commits group setup before the prompt and selects only the graded reply", () =>
  Effect.gen(function* () {
    const sent: Array<SentMessage> = [];
    const target = makeAgentHandle("evaluation-target", TARGET_ID);
    const deliveries = [
      targetResponse(
        UNSOLICITED_RESPONSE_ID,
        "correlated setup response",
        BYSTANDER_MESSAGE_ID,
      ),
      targetResponse(TARGET_RESPONSE_ID, "graded response", SENDER_MESSAGE_ID),
    ];
    const result = yield* Effect.scoped(
      speakingGroupEpisode(target, "bystander setup", "graded prompt"),
    ).pipe(Effect.provideService(Network, network(sent, deliveries)));

    assert.deepStrictEqual(sent, [
      { sender: "group-bystander-1", text: "bystander setup" },
      { sender: SENDER_NAME, text: "graded prompt" },
    ]);
    assert.deepStrictEqual(
      result.participants.map(({ name, role }) => ({ name, role })),
      [
        { name: "group-bystander-1", role: "bystander" },
        { name: SENDER_NAME, role: "sender" },
        { name: "evaluation-target", role: "target" },
      ],
    );
    assert.lengthOf(result.selectedResponses, 1);
    assert.strictEqual(result.selectedResponses[0].endpointName, SENDER_NAME);
    assert.strictEqual(
      result.selectedResponses[0].received.message.id,
      TARGET_RESPONSE_ID,
    );
  }));

// @agent-code-guard/regression-only: missing target correlation is rejected as typed evidence failure instead of being skipped
test("fails immediately when a target reply has no correlation", () =>
  Effect.gen(function* () {
    const target = makeAgentHandle("evaluation-target", TARGET_ID);
    const failure = yield* Effect.scoped(
      speakingGroupEpisode(target, "bystander setup", "graded prompt"),
    ).pipe(
      Effect.provideService(
        Network,
        network(
          [],
          [targetResponse(UNCORRELATED_RESPONSE_ID, "uncorrelated response")],
        ),
      ),
      Effect.flip,
    );

    assert.instanceOf(failure, NetworkFailure);
    assert.strictEqual(failure.operation, RECEIVE_OPERATION);
    assert.include(failure.detail, MISSING_REPLY_DETAIL);
    assert.include(failure.detail, UNCORRELATED_RESPONSE_ID);
    assert.include(failure.detail, SENDER_MESSAGE_ID);
  }));

test("selects only the probe reply from a cross-conversation episode", () =>
  Effect.gen(function* () {
    const target = makeAgentHandle("evaluation-target", TARGET_ID);
    const result = yield* Effect.scoped(
      crossConversationEpisode({
        target,
        setup: "remember this",
        probe: "what do you know?",
      }),
    ).pipe(Effect.provideService(Network, crossConversationNetwork()));

    assert.deepStrictEqual(
      result.participants.map(({ name, role }) => ({ name, role })),
      [
        { name: SENDER_NAME, role: "sender" },
        { name: PROBE_SENDER_NAME, role: "probe" },
        { name: "evaluation-target", role: "target" },
      ],
    );
    assert.lengthOf(result.selectedResponses, 1);
    assert.strictEqual(
      result.selectedResponses[0].endpointName,
      PROBE_SENDER_NAME,
    );
    assert.strictEqual(
      result.selectedResponses[0].received.message.id,
      PROBE_RESPONSE_ID,
    );
  }));

test("selects every graded turn from a direct multi-turn episode", () =>
  Effect.gen(function* () {
    const target = makeAgentHandle("evaluation-target", TARGET_ID);
    const result = yield* Effect.scoped(
      directMultiTurnEpisode(target, "opening", [
        "follow-up one",
        "follow-up two",
      ]),
    ).pipe(
      Effect.provideService(
        Network,
        network(
          [],
          [
            targetResponse(TARGET_RESPONSE_ID, "first"),
            targetResponse(SECOND_RESPONSE_ID, "second"),
            targetResponse(THIRD_RESPONSE_ID, "third"),
          ],
        ),
      ),
    );

    assert.deepStrictEqual(
      result.selectedResponses.map((response) => response.received.message.id),
      [TARGET_RESPONSE_ID, SECOND_RESPONSE_ID, THIRD_RESPONSE_ID],
    );
  }));
