/**
 * @file Gates for the two things that read the run's in-band messages:
 * the `awaitReplyFrom` step gate and the done-signal predicates that end
 * an episode.
 *
 * Every case here turns on one property. A predicate that fires on
 * society traffic can end a multi-step run before its schedule finishes,
 * and the run still produces a verdict — over a transcript that proves
 * nothing. So each test asserts not only that the right thing fires but
 * that the wrong thing does not: a message from another agent, a reply in
 * another conversation, and an answer to a step that is not the last one
 * each leave the episode running until the inactivity bound ends it.
 *
 * The floor an answer clears is the step's own message, written from the
 * send's synchronous result. No test posts it, because nothing in the run
 * has to wait for it: a case that had to arrange the floor's arrival
 * would be asserting the defect this file exists to pin.
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
  afterNthSend,
  decodedEvents,
  expectedAttemptPath,
  makeHeldPrincipal,
  nthReceipt,
  specInput,
  startHermetic,
  tempStoreRoot,
  whenLive,
  type StartedHermetic,
  type WireInput,
} from "./__tests__/support.js";
import { outcomeOf } from "./__tests__/coverage-shared.js";
import { EVENT, OUTCOME, TERMINATION } from "./__tests__/tags.js";
import {
  LAST_STEP_ANSWERED_DONE_SIGNAL,
  REPLIES_DONE_SIGNAL,
} from "./drivers.js";

/** Long enough that only a done-signal ends the run. */
const PATIENT_MS = 60_000;
/** Short enough to end an unanswered run, long enough to drive messages first. */
const QUIET_MS = 700;
const AGENT_COUNT = 2;

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

const LAST_STEP_ANSWERED = {
  name: LAST_STEP_ANSWERED_DONE_SIGNAL,
  config: {},
};

const FIRST = nthReceipt(1);
const SECOND = nthReceipt(2);

/**
 * Commit times of an answer to each step, between that step's send and
 * the next. Ordering is the server's `createdAt`, so a reply to the first
 * step stamped past the second step's send would clear a floor it never
 * answered — and the case that pins the arming rule would pass for the
 * wrong reason.
 */
const AFTER_FIRST = afterNthSend(1);
const AFTER_SECOND = afterNthSend(2);

/** A message from `sender` in the conversation the nth step opened. */
function reply(
  step: typeof FIRST,
  sender: string,
  id: string,
  createdAt = AFTER_SECOND,
): WireInput {
  return {
    messageId: uuidOf(id),
    conversationId: step.conversationId,
    taskId: step.taskId,
    sender,
    createdAt,
  };
}

function uuidOf(seedText: string): string {
  const hex = [...seedText]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(32, "0")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

function firingsOf(
  events: ReadonlyArray<SimulatorEvent>,
): ReadonlyArray<Extract<SimulatorEvent, { _tag: "trigger.predicate-fired" }>> {
  return events.flatMap((event) =>
    event._tag === EVENT.predicateFired ? [event] : [],
  );
}

function expectTermination(
  sealed: Parameters<typeof outcomeOf>[0],
  termination: string,
): void {
  expect(outcomeOf(sealed)).toMatchObject({
    _tag: OUTCOME.episode,
    termination,
  });
}

/** One run of `input` whose messages arrive once the episode is observing. */
function runWithMessages(
  input: unknown,
  root: string,
  messages: ReadonlyArray<WireInput>,
): Effect.Effect<StartedHermetic, unknown, never> {
  return startHermetic(input, root).pipe(
    Effect.tap((started) =>
      whenLive(started, AGENT_COUNT).pipe(
        Effect.flatMap(() =>
          Effect.forEach(messages, (one) => started.wire.observe(one), {
            concurrency: 1,
            discard: true,
          }),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// The `replies` done-signal
// ---------------------------------------------------------------------------

/**
 * Two stub agents, one that speaks and one that stays silent. `replies`
 * counts only the messages the named agent committed, so neither the
 * silent agent's presence nor the other agent's traffic may move the
 * count.
 */
function repliesBody(
  messages: ReadonlyArray<WireInput>,
  inactivityMs: number,
  expected: string,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf(
        [startStep()],
        {
          name: REPLIES_DONE_SIGNAL,
          config: { from: AGENT_ONE, minCount: 2 },
        },
        inactivityMs,
      ),
    });
    const started = yield* runWithMessages(input, root, messages);
    expectTermination(yield* started.join, expected);
  });
}

describe("the `replies` done-signal", () => {
  it("completes on the Nth message from the named agent", () =>
    Effect.runPromise(
      repliesBody(
        [reply(FIRST, AGENT_ONE, "m1"), reply(FIRST, AGENT_ONE, "m2")],
        PATIENT_MS,
        TERMINATION.completed,
      ).pipe(Effect.orDie),
    ));

  it("does not complete one message short: the run ends timeout", () =>
    Effect.runPromise(
      repliesBody(
        [reply(FIRST, AGENT_ONE, "m1")],
        QUIET_MS,
        TERMINATION.timeout,
      ).pipe(Effect.orDie),
    ));

  it("counts only the named agent, never the silent agent's peer", () =>
    Effect.runPromise(
      repliesBody(
        [reply(FIRST, AGENT_ONE, "m1"), reply(FIRST, AGENT_TWO, "m2")],
        QUIET_MS,
        TERMINATION.timeout,
      ).pipe(Effect.orDie),
    ));

  it("does not double-count one message redelivered", () =>
    Effect.runPromise(
      repliesBody(
        [reply(FIRST, AGENT_ONE, "m1"), reply(FIRST, AGENT_ONE, "m1")],
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

/** The target's reply to the setup step, in the conversation that step opened. */
const SETUP_ANSWERED: ReadonlyArray<WireInput> = [
  reply(FIRST, AGENT_ONE, "reply-to-setup", AFTER_FIRST),
];

/** The target's reply to the probe. A `send` step reuses the setup's conversation. */
const PROBE_ANSWERED: ReadonlyArray<WireInput> = [
  reply(FIRST, AGENT_ONE, "reply-to-probe", AFTER_SECOND),
];

function gatedBody(
  messages: ReadonlyArray<WireInput>,
  inactivityMs: number,
  expectSpoken: (
    spoken: ReadonlyArray<Extract<SimulatorEvent, { _tag: "step.spoken" }>>,
  ) => void,
  expectedTermination: string,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf(GATED_STEPS, LAST_STEP_ANSWERED, inactivityMs),
    });
    const started = yield* runWithMessages(input, root, messages);
    const sealed = yield* started.join;
    expectTermination(sealed, expectedTermination);
    expectSpoken(spokenOf(yield* eventsOf(started.store, input, root)));
  });
}

function expectBothSpoken(
  spoken: ReadonlyArray<Extract<SimulatorEvent, { _tag: "step.spoken" }>>,
): void {
  expect(spoken).toHaveLength(2);
  // A gated step is released by a predicate, so it is caused by the reply
  // it matched; an ungated step is a root event.
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
 * replies are observed before anything knows which conversation to watch.
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
    yield* whenLive(started, AGENT_COUNT);
    yield* held.requested(1);
    yield* Effect.forEach(SETUP_ANSWERED, (one) => started.wire.observe(one), {
      concurrency: 1,
      discard: true,
    });
    yield* held.release;
    yield* Effect.forEach(PROBE_ANSWERED, (one) => started.wire.observe(one), {
      concurrency: 1,
      discard: true,
    });
    const sealed = yield* started.join;
    expectTermination(sealed, TERMINATION.completed);
    expect(spokenOf(yield* eventsOf(started.store, input, root))).toHaveLength(
      2,
    );
  });
}

// @agent-code-guard/regression-only: each case runs a live hermetic episode to pin one discrimination rule, so a generative gate here would execute a full run per case; the match rule's invariants are property-tested where they are cheap, in wire-log.test.ts
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
        [reply(SECOND, AGENT_ONE, "elsewhere", AFTER_FIRST)],
        QUIET_MS,
        expectOnlySetupSpoken,
        TERMINATION.timeout,
      ).pipe(Effect.orDie),
    ));

  it("ignores a reply from another agent: the gated step never speaks", () =>
    Effect.runPromise(
      gatedBody(
        [reply(FIRST, AGENT_TWO, "not-the-target", AFTER_FIRST)],
        QUIET_MS,
        expectOnlySetupSpoken,
        TERMINATION.timeout,
      ).pipe(Effect.orDie),
    ));

  it("matches a reply observed before the receipt that names its conversation", () =>
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
  messages: ReadonlyArray<WireInput>,
  inactivityMs: number,
  expected: string,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf(TWO_TASK_STEPS, LAST_STEP_ANSWERED, inactivityMs),
    });
    const started = yield* runWithMessages(input, root, messages);
    expectTermination(yield* started.join, expected);
  });
}

/**
 * The answer to the first step releases the gated second step. A
 * predicate armed by anything but the last step's own send would fire on
 * that same answer and seal the run before the second step ever speaks —
 * the exact truncation the arming rule exists to prevent. So the episode
 * must run on, speak the second step, and end `timeout` when nobody
 * answers it.
 */
function armsOnlyOnLastStepBody(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf(GATED_STEPS, LAST_STEP_ANSWERED, QUIET_MS),
    });
    const started = yield* runWithMessages(input, root, SETUP_ANSWERED);
    expectTermination(yield* started.join, TERMINATION.timeout);
    expect(spokenOf(yield* eventsOf(started.store, input, root))).toHaveLength(
      2,
    );
  });
}

/**
 * The step is answered before its own `step.spoken` reaches the observer.
 * Nothing re-delivers an answer already recorded, so a predicate that only
 * re-read on later events would wait out the run on an answer it already
 * held. This is the run that used to seal `timeout` with the reply in its
 * own recording.
 */
function answeredBeforeArmingBody(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf([startStep()], LAST_STEP_ANSWERED, PATIENT_MS),
    });
    const held = yield* makeHeldPrincipal(1);
    const started = yield* startHermetic(input, root, {
      internals: { makePrincipal: () => Effect.succeed(held.principal) },
    });
    yield* whenLive(started, AGENT_COUNT);
    yield* held.requested(1);
    // Observed while the step is still in flight: the answer is in the log
    // before the receipt that names the floor it has to clear.
    yield* started.wire.observe(
      reply(FIRST, AGENT_ONE, "early-answer", AFTER_FIRST),
    );
    yield* Effect.sleep("100 millis");
    yield* held.release;
    expectTermination(yield* started.join, TERMINATION.completed);
  });
}

/**
 * One termination, one recorded firing. The predicate is re-read on the
 * arming step and on every later message, so an unlatched one emits a
 * `trigger.predicate-fired` per event after the condition holds and a
 * reader counting causes sees more than ever happened.
 */
function firesOnceBody(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      episode: episodeOf([startStep()], LAST_STEP_ANSWERED, PATIENT_MS),
    });
    const started = yield* runWithMessages(input, root, [
      reply(FIRST, AGENT_ONE, "answer", AFTER_FIRST),
      reply(FIRST, AGENT_ONE, "and-another", AFTER_SECOND),
      reply(FIRST, AGENT_ONE, "and-a-third", AFTER_SECOND),
    ]);
    expectTermination(yield* started.join, TERMINATION.completed);
    const firings = firingsOf(yield* eventsOf(started.store, input, root));
    expect(firings).toHaveLength(1);
  });
}

// @agent-code-guard/regression-only: each case runs a live hermetic episode to pin one arming or discrimination rule; the underlying match rule is property-tested in wire-log.test.ts
describe("the `last-step-answered` done-signal", () => {
  it("completes when the last step is answered", () =>
    Effect.runPromise(
      lastStepBody(
        [reply(SECOND, AGENT_ONE, "reply-to-probe", AFTER_SECOND)],
        PATIENT_MS,
        TERMINATION.completed,
      ).pipe(Effect.orDie),
    ));

  it("completes on an answer observed before the step that armed it", () =>
    Effect.runPromise(answeredBeforeArmingBody().pipe(Effect.orDie)));

  it("records exactly one firing for one termination", () =>
    Effect.runPromise(firesOnceBody().pipe(Effect.orDie)));

  it("cannot fire on an answer to an earlier step and truncate the schedule", () =>
    Effect.runPromise(armsOnlyOnLastStepBody().pipe(Effect.orDie)));

  it("ignores a response from an agent the last step never spoke to", () =>
    Effect.runPromise(
      lastStepBody(
        [reply(SECOND, AGENT_TWO, "not-a-participant", AFTER_SECOND)],
        QUIET_MS,
        TERMINATION.timeout,
      ).pipe(Effect.orDie),
    ));

  it("does not complete when only an earlier step is answered", () =>
    Effect.runPromise(
      lastStepBody(
        [reply(FIRST, AGENT_ONE, "reply-to-setup", AFTER_FIRST)],
        QUIET_MS,
        TERMINATION.timeout,
      ).pipe(Effect.orDie),
    ));
});
