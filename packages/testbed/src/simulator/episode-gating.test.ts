/**
 * @file Gates for the two things that read delivered-message spans: the
 * `awaitReplyFrom` step gate and the done-signal predicates that end an
 * episode.
 *
 * Every case here turns on one property. A predicate that fires on
 * society traffic can end a multi-step run before its schedule finishes,
 * and the run still produces a verdict — over a transcript that proves
 * nothing. So each test asserts not only that the right thing fires but
 * that the wrong thing does not: a message from another agent, a reply in
 * another conversation, and an answer to a step that is not the last one
 * each leave the episode running until the inactivity bound ends it.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { SimulatorEvent } from "./event-log.js";
import type { RecordingStore } from "./recording.js";
import {
  AGENT_ONE,
  AGENT_TWO,
  PRINCIPAL_NAME,
  SAY_TEXT,
  awaitAgents,
  decodedEvents,
  expectedAttemptPath,
  fakeAgentId,
  makeHeldPrincipal,
  nthReceipt,
  postDeliveredSpans,
  specInput,
  startHermetic,
  tempStoreRoot,
  type DeliveredSpanInput,
  type StartedHermetic,
} from "./__tests__/support.js";
import { EVENT, EXIT, OUTCOME, TERMINATION } from "./__tests__/tags.js";

/** Long enough that only a done-signal ends the run. */
const PATIENT_MS = 60_000;
/** Short enough to end an unanswered run, long enough to post spans first. */
const QUIET_MS = 700;
const AGENT_COUNT = 2;
/** The episode's tap is forked at start; spans posted before it subscribes are not observed. */
const SETTLE_MS = 150;

type StepInput = Record<string, unknown>;

function episodeOf(
  steps: ReadonlyArray<StepInput>,
  doneSignal: unknown,
  inactivityMs: number,
): unknown {
  return {
    steps,
    termination: {
      inactivityTimeoutMs: inactivityMs,
      onAgentCrash: "halt",
      doneSignal,
    },
  };
}

const startStep = (name?: string): StepInput => ({
  ...(name === undefined ? {} : { name }),
  by: PRINCIPAL_NAME,
  with: [AGENT_ONE],
  say: SAY_TEXT,
});

const LAST_STEP_ANSWERED = { name: "last-step-answered", config: {} };

/** A message from `sender` in `conversationId`. */
function delivered(
  conversationId: string,
  sender: string,
  messageId: string,
): DeliveredSpanInput {
  return { conversationId, senderId: fakeAgentId(sender), messageId };
}

/** The span carrying a step's own message: the floor an answer has to clear. */
function ownMessage(
  conversationId: string,
  messageId: string,
): DeliveredSpanInput {
  return delivered(conversationId, PRINCIPAL_NAME, messageId);
}

/** The endpoint, once the agents are up and the episode's tap is subscribed. */
function liveEndpoint(
  started: StartedHermetic,
): Effect.Effect<string, never, never> {
  return started.endpoint.pipe(
    Effect.tap(() => awaitAgents(started.launch, AGENT_COUNT)),
    Effect.tap(() => Effect.sleep(`${SETTLE_MS} millis`)),
  );
}

function eventsOf(
  store: RecordingStore,
  input: unknown,
  root: string,
): Effect.Effect<ReadonlyArray<SimulatorEvent>, unknown, never> {
  return expectedAttemptPath(input, root).pipe(
    Effect.flatMap((path) => store.read(path)),
    Effect.flatMap(decodedEvents),
  );
}

function spokenOf(
  events: ReadonlyArray<SimulatorEvent>,
): ReadonlyArray<Extract<SimulatorEvent, { _tag: "step.spoken" }>> {
  return events.flatMap((event) =>
    event._tag === EVENT.stepSpoken ? [event] : [],
  );
}

function expectTermination(
  sealed: { readonly _tag: string },
  termination: string,
): void {
  expect(sealed._tag).toBe(EXIT.success);
  expect(sealed).toMatchObject({
    value: { outcome: { _tag: OUTCOME.episode, termination } },
  });
}

/** One run of `input` whose spans are posted once the episode is observing. */
function runWithSpans(
  input: unknown,
  root: string,
  spans: ReadonlyArray<DeliveredSpanInput>,
): Effect.Effect<StartedHermetic, unknown, never> {
  return startHermetic(input, root).pipe(
    Effect.tap((started) =>
      liveEndpoint(started).pipe(
        Effect.flatMap((endpoint) => postDeliveredSpans(endpoint, spans)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// The `replies` done-signal
// ---------------------------------------------------------------------------

const FIRST = nthReceipt(1);
const SECOND = nthReceipt(2);

/**
 * Two stub agents, one that speaks and one that stays silent. `replies`
 * counts only the messages the named agent committed, so neither the
 * silent agent's presence nor the other agent's traffic may move the
 * count.
 */
function repliesBody(
  messages: ReadonlyArray<DeliveredSpanInput>,
  inactivityMs: number,
  expected: string,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf(
        [startStep()],
        { name: "replies", config: { from: AGENT_ONE, minCount: 2 } },
        inactivityMs,
      ),
    });
    const started = yield* runWithSpans(input, root, messages);
    expectTermination(yield* started.join, expected);
  });
}

describe("the `replies` done-signal", () => {
  it("completes on the Nth message from the named agent", () =>
    Effect.runPromise(
      repliesBody(
        [
          delivered(FIRST.conversationId, AGENT_ONE, "m1"),
          delivered(FIRST.conversationId, AGENT_ONE, "m2"),
        ],
        PATIENT_MS,
        TERMINATION.completed,
      ).pipe(Effect.orDie),
    ));

  it("does not complete one message short: the run ends timeout", () =>
    Effect.runPromise(
      repliesBody(
        [delivered(FIRST.conversationId, AGENT_ONE, "m1")],
        QUIET_MS,
        TERMINATION.timeout,
      ).pipe(Effect.orDie),
    ));

  it("counts only the named agent, never the silent agent's peer", () =>
    Effect.runPromise(
      repliesBody(
        [
          delivered(FIRST.conversationId, AGENT_ONE, "m1"),
          delivered(FIRST.conversationId, AGENT_TWO, "m2"),
        ],
        QUIET_MS,
        TERMINATION.timeout,
      ).pipe(Effect.orDie),
    ));
});

// ---------------------------------------------------------------------------
// The `awaitReplyFrom` step gate
// ---------------------------------------------------------------------------

const GATED_STEPS: ReadonlyArray<StepInput> = [
  startStep("setup"),
  {
    by: PRINCIPAL_NAME,
    into: "setup",
    awaitReplyFrom: AGENT_ONE,
    say: "the probe",
  },
];

/** The setup step's own message, then the target's reply to it. */
const SETUP_ANSWERED: ReadonlyArray<DeliveredSpanInput> = [
  ownMessage(FIRST.conversationId, FIRST.messageId),
  delivered(FIRST.conversationId, AGENT_ONE, "reply-to-setup"),
];

/** The probe's own message, then the target's reply to it. A `send` step reuses the conversation. */
const PROBE_ANSWERED: ReadonlyArray<DeliveredSpanInput> = [
  ownMessage(FIRST.conversationId, SECOND.messageId),
  delivered(FIRST.conversationId, AGENT_ONE, "reply-to-probe"),
];

function gatedBody(
  spans: ReadonlyArray<DeliveredSpanInput>,
  inactivityMs: number,
  expect2: (
    spoken: ReadonlyArray<Extract<SimulatorEvent, { _tag: "step.spoken" }>>,
  ) => void,
  expectedTermination: string,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf(GATED_STEPS, LAST_STEP_ANSWERED, inactivityMs),
    });
    const started = yield* runWithSpans(input, root, spans);
    const sealed = yield* started.join;
    expectTermination(sealed, expectedTermination);
    expect2(spokenOf(yield* eventsOf(started.store, input, root)));
  });
}

function expectBothSpoken(
  spoken: ReadonlyArray<Extract<SimulatorEvent, { _tag: "step.spoken" }>>,
): void {
  expect(spoken).toHaveLength(2);
  // A gated step is released by a predicate, so it is caused by the reply
  // span it matched; an ungated step is a root event.
  expect(spoken[0]?.causationId).toBeUndefined();
  expect(spoken[1]?.causationId).toBeGreaterThan(0);
}

function expectOnlySetupSpoken(
  spoken: ReadonlyArray<Extract<SimulatorEvent, { _tag: "step.spoken" }>>,
): void {
  expect(spoken).toHaveLength(1);
}

/**
 * The setup step is requested but its receipt does not exist yet, so both
 * spans drain before anything knows which conversation to watch.
 * Retention, not arming, is what matches them.
 */
function drainedBeforeReceiptBody(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf(GATED_STEPS, LAST_STEP_ANSWERED, PATIENT_MS),
    });
    const held = yield* makeHeldPrincipal(1);
    const started = yield* startHermetic(input, root, {
      internals: { makePrincipal: () => Effect.succeed(held.principal) },
    });
    const endpoint = yield* liveEndpoint(started);
    yield* held.requested(1);
    yield* postDeliveredSpans(endpoint, SETUP_ANSWERED);
    yield* held.release;
    yield* postDeliveredSpans(endpoint, PROBE_ANSWERED);
    const sealed = yield* started.join;
    expectTermination(sealed, TERMINATION.completed);
    expect(spokenOf(yield* eventsOf(started.store, input, root))).toHaveLength(
      2,
    );
  });
}

describe("the `awaitReplyFrom` step gate", () => {
  it("releases the gated step on the target's reply to the previous one", () =>
    Effect.runPromise(
      gatedBody(
        [...SETUP_ANSWERED, ...PROBE_ANSWERED],
        PATIENT_MS,
        expectBothSpoken,
        TERMINATION.completed,
      ).pipe(Effect.orDie),
    ));

  it("ignores the target's traffic in another conversation: the gated step never speaks", () =>
    Effect.runPromise(
      gatedBody(
        [
          ownMessage(FIRST.conversationId, FIRST.messageId),
          delivered(SECOND.conversationId, AGENT_ONE, "elsewhere"),
        ],
        QUIET_MS,
        expectOnlySetupSpoken,
        TERMINATION.timeout,
      ).pipe(Effect.orDie),
    ));

  it("matches a reply whose span drains before the receipt that names its conversation", () =>
    Effect.runPromise(drainedBeforeReceiptBody().pipe(Effect.orDie)));
});

// ---------------------------------------------------------------------------
// The `last-step-answered` done-signal
// ---------------------------------------------------------------------------

/** Two `start` steps, so each step's answer lands in its own conversation. */
const TWO_TASK_STEPS: ReadonlyArray<StepInput> = [
  startStep("setup"),
  { by: PRINCIPAL_NAME, with: [AGENT_ONE], say: "the probe" },
];

function lastStepBody(
  spans: ReadonlyArray<DeliveredSpanInput>,
  inactivityMs: number,
  expected: string,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf(TWO_TASK_STEPS, LAST_STEP_ANSWERED, inactivityMs),
    });
    const started = yield* runWithSpans(input, root, spans);
    expectTermination(yield* started.join, expected);
  });
}

/**
 * The answer to the first step releases the gated second step. A
 * predicate armed by anything but the last step's own `step.spoken` would
 * fire on that same answer and seal the run before the second step ever
 * speaks — the exact truncation the arming rule exists to prevent. So the
 * episode must run on, speak the second step, and end `timeout` when
 * nobody answers it.
 */
function armsOnlyOnLastStepBody(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf(GATED_STEPS, LAST_STEP_ANSWERED, QUIET_MS),
    });
    const started = yield* runWithSpans(input, root, SETUP_ANSWERED);
    expectTermination(yield* started.join, TERMINATION.timeout);
    expect(spokenOf(yield* eventsOf(started.store, input, root))).toHaveLength(
      2,
    );
  });
}

describe("the `last-step-answered` done-signal", () => {
  it("completes when the last step is answered", () =>
    Effect.runPromise(
      lastStepBody(
        [
          ownMessage(SECOND.conversationId, SECOND.messageId),
          delivered(SECOND.conversationId, AGENT_ONE, "reply-to-probe"),
        ],
        PATIENT_MS,
        TERMINATION.completed,
      ).pipe(Effect.orDie),
    ));

  it("cannot fire on an answer to an earlier step and truncate the schedule", () =>
    Effect.runPromise(armsOnlyOnLastStepBody().pipe(Effect.orDie)));

  it("does not complete when only an earlier step is answered", () =>
    Effect.runPromise(
      lastStepBody(
        [
          ownMessage(FIRST.conversationId, FIRST.messageId),
          delivered(FIRST.conversationId, AGENT_ONE, "reply-to-setup"),
        ],
        QUIET_MS,
        TERMINATION.timeout,
      ).pipe(Effect.orDie),
    ));
});
