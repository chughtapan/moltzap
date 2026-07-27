/**
 * @file Gates for what one observation tells the episode.
 *
 * A boolean could carry none of this, and the three non-firing outcomes
 * are the ones that matter: an unanswered step waits, an unorderable pair
 * waits and says so, and a missing floor is a defect that has to end the
 * run. Collapsing any of them into "not yet" is the shape where a correct
 * answer seals as `timeout`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import { AgentId } from "@moltzap/protocol/identity";
import { TaskId } from "@moltzap/protocol/task";
import { LogicalSequence, RunId, WallTimeMs } from "./ids.js";
import { AgentName, LogicalTime, PrincipalName } from "./run-spec.js";
import { WireMessage, type SimulatorEvent } from "./event-log.js";
import { makeDonePredicate, LAST_STEP_ANSWERED_DONE_SIGNAL } from "./drivers.js";
import type { PredicateContext, PredicateOutcome } from "./drivers.js";
import type { SpeechReceipt } from "./episode.js";
import { makeMessageLog, observedFrom } from "./wire-log.js";
import { OUTCOME_TAG, STALL_REASON } from "./__tests__/tags.js";

function uuid(seedText: string): string {
  const hex = [...seedText]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(32, "0")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const TASK = Schema.decodeSync(TaskId)(uuid("task"));
const CONVERSATION = Schema.decodeSync(ConversationId)(uuid("conversation"));
const AGENT = Schema.decodeSync(AgentId)(uuid("agent-one"));
const PRINCIPAL = Schema.decodeSync(AgentId)(uuid("principal"));

const STEP_AT = "2026-01-01T00:00:01.000Z";
const ANSWER_AT = "2026-01-01T00:00:02.000Z";

const receipt: SpeechReceipt = {
  taskId: TASK,
  conversationId: CONVERSATION,
  message: {
    id: Schema.decodeSync(MessageId)(uuid("step")),
    conversationId: CONVERSATION,
    senderId: PRINCIPAL,
    parts: [{ type: "text", text: "the step" }],
    createdAt: STEP_AT,
  },
};

function wireEvent(name: string, createdAt: string): WireMessage {
  return new WireMessage({
    runId: Schema.decodeSync(RunId)("run-1"),
    logicalSequence: Schema.decodeSync(LogicalSequence)(7),
    logicalTime: Schema.decodeSync(LogicalTime)(0),
    wallTime: Schema.decodeSync(WallTimeMs)(0),
    source: "wire",
    observedBy: Schema.decodeSync(PrincipalName)("operator"),
    observation: "live",
    messageId: Schema.decodeSync(MessageId)(uuid(name)),
    conversationId: CONVERSATION,
    taskId: TASK,
    senderId: AGENT,
    parts: [{ type: "text", text: "the answer" }],
    createdAt,
  });
}

type Fixture = {
  readonly observe: (event: SimulatorEvent) => PredicateOutcome;
  readonly context: PredicateContext;
};

/** A fixture that has already observed one answer, and the answer itself. */
type Answered = Fixture & { readonly event: WireMessage };

/** A `last-step-answered` predicate armed on `receipt`, over an empty log. */
function armed(): Fixture {
  const context: PredicateContext = {
    agentIds: new Map([["agent-one", AGENT]]),
    steps: [
      {
        by: Schema.decodeSync(PrincipalName)("operator"),
        with: [Schema.decodeSync(AgentName)("agent-one")],
        say: "the step",
        atMs: Schema.decodeSync(LogicalTime)(0),
      },
    ],
    messages: makeMessageLog(),
    lastSpoken: { receipt },
  };
  const predicate = Effect.runSync(
    makeDonePredicate(
      { name: LAST_STEP_ANSWERED_DONE_SIGNAL, config: {} },
      context,
    ),
  );
  return { observe: (event) => predicate.observe(event), context };
}

/** Arm the predicate with the floor written and one answer observed. */
function withAnswer(name: string, createdAt: string): Answered {
  const fixture = armed();
  fixture.context.messages.record(
    undefined,
    "sent",
    observedFrom(receipt.message),
  );
  const event = wireEvent(name, createdAt);
  fixture.context.messages.record(event.logicalSequence, "received", {
    messageId: event.messageId,
    conversationId: event.conversationId,
    senderId: event.senderId,
    replyToId: undefined,
    createdAt: event.createdAt,
  });
  return { ...fixture, event };
}

describe("the `last-step-answered` predicate outcome", () => {
  it("reports a missing floor as a defect naming the awaited message", () => {
    const outcome = armed().observe(wireEvent("answer", ANSWER_AT));
    expect(outcome._tag).toBe(OUTCOME_TAG.defective);
    expect(
      outcome._tag === OUTCOME_TAG.defective ? outcome.detail : "",
    ).toContain(receipt.message.id);
  });

  it("fires on the answer once the floor is written", () => {
    const fixture = withAnswer("answer", ANSWER_AT);
    expect(fixture.observe(fixture.event)).toStrictEqual({
      _tag: OUTCOME_TAG.fired,
      at: fixture.event.logicalSequence,
    });
  });

  it("stalls rather than guessing when the answer shares the step's millisecond", () => {
    const fixture = withAnswer("tied", STEP_AT);
    const outcome = fixture.observe(fixture.event);
    expect(outcome._tag).toBe(OUTCOME_TAG.stalled);
    expect(outcome._tag === OUTCOME_TAG.stalled ? outcome.reason : "").toBe(
      STALL_REASON.ambiguousOrder,
    );
  });
});
