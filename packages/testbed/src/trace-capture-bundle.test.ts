/**
 * @file The fold's projection: a sealed recording's events become the
 * conversation cc-judge grades. Attribution is the load-bearing part —
 * the target's answers are the graded text, so an id that cannot be
 * attributed has to read as a broken recording rather than as a short
 * conversation. Events are decoded through `decodeEventLine`, the same
 * boundary a grader crosses, so a schema change fails here too.
 */
/* eslint-disable sonarjs/assertions-in-tests -- each entry runs one prepared effect whose expectations live beside the recording it projects */
// @agent-code-guard/regression-only: the subject is attribution over hand-built recordings; each case pins one branch of "who spoke"
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { agentId } from "@moltzap/protocol/testing";
import {
  projectRecordedConversation,
  type RecordedConversation,
} from "./trace-capture-bundle.js";
import { decodeEventLine } from "./simulator/index.js";

const RUN_ID = "abcdef012345-s1-a1";
const TARGET_SLOT = "openclaw-eval-agent";
const PRINCIPAL_NAME = "eval-sender";
const CONVERSATION = "conv-1";
const TARGET_ID = agentId("11111111-1111-4111-8111-111111111111");
const PRINCIPAL_ID = agentId("22222222-2222-4222-8222-222222222222");
const ANSWER = "they are task-scoped";

function envelope(sequence: number) {
  return {
    runId: RUN_ID,
    logicalSequence: sequence,
    logicalTime: sequence,
    wallTime: 1_700_000_000_000 + sequence,
  };
}

function ready(sequence: number, agent: string, id: string): unknown {
  return {
    ...envelope(sequence),
    _tag: "agent.ready",
    source: "lifecycle",
    agent,
    agentId: id,
  };
}

function message(
  sequence: number,
  senderId: string,
  text: string,
  id: string,
): unknown {
  return {
    ...envelope(sequence),
    _tag: "transcript.message",
    source: "transcript",
    conversationId: CONVERSATION,
    conversationSeq: sequence,
    senderId,
    message: { id, parts: [{ type: "text", text }] },
    createdAtWallTime: 1_700_000_000_000 + sequence,
  };
}

/** Decode hand-built lines the way a grader does, then project them. */
function project(
  lines: ReadonlyArray<unknown>,
): Effect.Effect<RecordedConversation | undefined, never, never> {
  return Effect.forEach(
    lines,
    (line) => decodeEventLine(JSON.stringify(line)),
    { concurrency: 1 },
  ).pipe(
    Effect.map((events) =>
      projectRecordedConversation({
        events,
        targetSlot: TARGET_SLOT,
        principalName: PRINCIPAL_NAME,
      }),
    ),
    Effect.orDie,
  );
}

const exchange = [
  ready(1, TARGET_SLOT, TARGET_ID),
  message(2, PRINCIPAL_ID, "how do conversations work here?", "m1"),
  message(3, TARGET_ID, ANSWER, "m2"),
];

const attributesTheExchange = project(exchange).pipe(
  Effect.map((projected) => {
    expect(projected?.targetAgentId).toBe(TARGET_ID);
    expect(projected?.responses).toEqual([
      {
        conversationId: CONVERSATION,
        senderId: TARGET_ID,
        text: ANSWER,
        messageId: "m2",
      },
    ]);
    expect(projected?.participants).toEqual([
      { id: PRINCIPAL_ID, name: PRINCIPAL_NAME, role: "sender" },
    ]);
    expect(
      projected?.traceEvents.map((event) => event.senderDisplayName),
    ).toEqual([PRINCIPAL_NAME, TARGET_SLOT]);
  }),
);

const refusesWithoutReady = project(exchange.slice(1)).pipe(
  Effect.map((projected) => {
    expect(projected).toBeUndefined();
  }),
);

const refusesForeignSender = project([
  ready(1, TARGET_SLOT, TARGET_ID),
  message(2, "not-an-agent-id", "hello", "m1"),
]).pipe(
  Effect.map((projected) => {
    expect(projected).toBeUndefined();
  }),
);

describe("recorded conversation projection", () => {
  it("attributes the target's answers and names the principal", () =>
    Effect.runPromise(attributesTheExchange));

  it("refuses a recording whose target slot never reached ready", () =>
    Effect.runPromise(refusesWithoutReady));

  it("refuses a recording whose sender is not a protocol agent id", () =>
    Effect.runPromise(refusesForeignSender));
});
