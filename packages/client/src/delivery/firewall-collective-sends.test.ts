/** @file A firewall's checks of what the agent sends in a collective operation, through real Client storage and send preparation. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber } from "effect";
import { describe, expect } from "vitest";
import type { MiddlewareInput } from "../firewall/values.js";
import {
  admitPending,
  answerBob,
  bob,
  formSchema,
  gatherRequestContent,
  gatherSend,
  group,
  holdMarked,
  marker,
  question,
  seedRequest,
  sendInput,
  STALE_CAPTURES,
  unfinishedIntents,
} from "../__tests__/firewall-collective-fixtures.js";
import {
  auditChecks,
  block,
  churnPolicy,
  fixture,
  type Fixture,
  incomingFixture,
  outgoingFixture,
  pass,
  policy,
} from "../__tests__/firewall-runtime-fixtures.js";
import { FirewallSendError } from "../firewall/runtime.js";
import { renderOutcome } from "../transport/collectives/render.js";

// @agent-code-guard/regression-only: Exercises collective refusal and binding through SQLite and the protocol engine.

function refusesAHeldGatherOnTheToolCall() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(subject, holdMarked());

    const refusal = yield* Effect.flip(
      delivery.operations.send({
        input: gatherSend(`${marker} ${question}`),
        failureDelivery: "inbound",
      }),
    );

    expect(refusal).toBeInstanceOf(FirewallSendError);
    expect(refusal).toMatchObject({ refusal: "prohibited" });
    expect(yield* unfinishedIntents(subject)).toEqual([]);
    expect((yield* delivery.operations.readInbox({})).items).toEqual([]);
    expect(yield* auditChecks(subject)).toMatchObject([
      {
        direction: "outgoing",
        disposition: "withheld",
        post: null,
        input: { message: { operation: { kind: "request", op: "gather" } } },
      },
    ]);
  });
}

function bindsAShadowGatherInGuidanceMode() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(subject, holdMarked(), {
      mode: "guidance",
    });

    const sending = yield* delivery.operations
      .send({ input: gatherSend(`${marker} ${question}`) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);

    expect(yield* awaitBoundIntents(subject, 2)).toHaveLength(2);
    yield* Fiber.interrupt(sending);
  });
}

function refusesAGatherAfterStaleCaptures() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const churn = churnPolicy(subject);
    const delivery = yield* outgoingFixture(subject, churn.middleware);

    const refusal = yield* Effect.flip(
      delivery.operations.send({ input: gatherSend(question) }),
    );

    expect(refusal).toMatchObject({ refusal: "unresolved-evidence" });
    expect(churn.count()).toBe(STALE_CAPTURES);
    expect(yield* unfinishedIntents(subject)).toEqual([]);
  });
}

function checksAnAllGatherAsItsQuestion() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const seen: MiddlewareInput[] = [];
    const delivery = yield* outgoingFixture(subject, holdMarked(seen));

    const refusal = yield* Effect.flip(
      delivery.operations.send({
        input: gatherSend(`${marker} ${question}`, "all_gather"),
      }),
    );

    expect(refusal).toMatchObject({ refusal: "prohibited" });
    expect(seen[0]?.event.message).toMatchObject({
      sender: subject.local.card.agentId,
      operation: { kind: "request", op: "all_gather" },
    });
    expect(seen[0]?.event.message.recipients).toEqual(
      expect.arrayContaining([
        subject.remote.card.agentId,
        subject.third.card.agentId,
      ]),
    );
    expect(seen[0]?.event.message.text).toContain(
      `all_gather from agent:alice to ${group}`,
    );
    expect(yield* unfinishedIntents(subject)).toEqual([]);
  });
}

function keepsARequestOpenAfterARefusedAnswer() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedRequest(subject, Date.now() + 60_000, question);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    yield* admitPending(runtime);
    const refused = {
      input: answerBob({ slot: "mon", note: marker }),
      idempotencyKey: "answer-1",
    };
    const allowed = { kind: "answered", content: { slot: "tue" } } as const;

    const first = yield* Effect.flip(runtime.delivery.operations.send(refused));
    const replayed = yield* Effect.flip(
      runtime.delivery.operations.send(refused),
    );
    const answering = yield* runtime.delivery.operations
      .send({ input: answerBob(allowed.content) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);

    expect(first).toBeInstanceOf(FirewallSendError);
    expect(replayed).toEqual(first);
    expect(
      seen
        .filter((input) => input.event.direction === "outgoing")
        .map((input) => input.event.message),
    ).toMatchObject([
      { operation: { kind: "answer", op: "gather" } },
      { text: renderOutcome(allowed) },
    ]);
    expect(yield* unfinishedIntents(subject)).toHaveLength(1);
    yield* Fiber.interrupt(answering);
  });
}

function bindsARequestPostOnlyAgainstItsAdmittedCheck() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(subject, holdMarked());
    const sending = yield* delivery.operations
      .send({ input: gatherSend(question) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);
    const bound = yield* awaitBoundIntents(subject, 2);
    const [gatherCheck] = yield* auditChecks(subject);
    const other = yield* gatherRequestContent(Date.now() + 60_000, question);

    const otherContent = yield* Effect.flip(
      subject.engine.sendAdmitted(
        { to: bob, content: other },
        gatherCheck?.checkId ?? "",
      ),
    );
    const unknownCheck = yield* Effect.flip(
      subject.engine.sendAdmitted(
        { to: bob, content: other },
        `chk_${"0".repeat(64)}`,
      ),
    );

    expect(otherContent).toMatchObject({
      reason: "certification-unavailable",
    });
    expect(unknownCheck).toMatchObject({
      reason: "certification-unavailable",
    });
    expect(yield* unfinishedIntents(subject)).toEqual(bound);
    yield* Fiber.interrupt(sending);
  });
}

function refusesAnAnswerWhoseRequestExpiresDuringItsCheck() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const deadlineAt = Date.now() + 3_000;
    yield* seedRequest(subject, deadlineAt, question);
    const runtime = yield* incomingFixture(
      subject,
      policy((input) =>
        input.event.direction === "outgoing"
          ? Effect.sleep(untilPast(deadlineAt)).pipe(Effect.as(pass))
          : Effect.succeed(pass),
      ),
      {},
      false,
    );
    yield* admitPending(runtime);

    const refusal = yield* Effect.flip(
      runtime.delivery.operations.send({ input: answerBob({ slot: "mon" }) }),
    );

    expect(refusal).toMatchObject({ failure: { kind: "request-expired" } });
    expect(yield* unfinishedIntents(subject)).toEqual([]);
    expect((yield* auditChecks(subject)).at(-1)).toMatchObject({
      direction: "outgoing",
      disposition: "withheld",
      result: { judgment: "allow" },
    });
  });
}

/** Send a collecting operation that closes one second after it is sent. */
function sendClosingInASecond(
  delivery: Effect.Effect.Success<ReturnType<typeof outgoingFixture>>,
  op: "gather" | "all_gather",
) {
  return delivery.operations.send({
    input: sendInput({
      to: group,
      text: question,
      collective: { op, deadline: 1, requestedSchema: formSchema },
    }),
  });
}

function failsWhenTheDeadlinePassesDuringTheCheck(op: "gather" | "all_gather") {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(
      subject,
      policy(() => Effect.sleep(Duration.millis(1_100)).pipe(Effect.as(pass))),
    );

    const failure = yield* Effect.flip(sendClosingInASecond(delivery, op));

    expect(failure).toMatchObject({ failure: { kind: "deadline-passed" } });
    expect(yield* unfinishedIntents(subject)).toEqual([]);
    expect((yield* delivery.operations.readInbox({})).items).toEqual([]);
  });
}

function refusesAHeldAllGatherWithoutOpeningIt() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(
      subject,
      policy(() => Effect.sleep(Duration.millis(1_100)).pipe(Effect.as(block))),
    );

    const refusal = yield* Effect.flip(
      sendClosingInASecond(delivery, "all_gather"),
    );

    expect(refusal).toBeInstanceOf(FirewallSendError);
    expect(yield* unfinishedIntents(subject)).toEqual([]);
  });
}

/** The time from now until just after `at`. */
function untilPast(at: number): Duration.Duration {
  return Duration.millis(Math.max(0, at - Date.now()) + 50);
}

/** Wait, up to ten seconds, until the test's sends have bound `count` intents. */
function awaitBoundIntents(subject: Fixture, count: number) {
  return unfinishedIntents(subject).pipe(
    Effect.delay(Duration.millis(10)),
    Effect.repeat({ until: (intents) => intents.length >= count }),
    Effect.timeoutFail({
      duration: Duration.seconds(10),
      onTimeout: () => new Error(`fewer than ${count} intents bound`),
    }),
  );
}

function bindsNothingWhenStoppedDuringAGatherCheck() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const entered = yield* Deferred.make<undefined>();
    const suspended = policy(() =>
      Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
    );
    const delivery = yield* outgoingFixture(subject, suspended);
    const sending = yield* delivery.operations
      .send({ input: gatherSend(question) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(sending);

    expect(yield* unfinishedIntents(subject)).toEqual([]);
    expect(yield* auditChecks(subject)).toMatchObject([
      { disposition: "checking", result: null },
    ]);
  });
}

describe("collective sends under a firewall", () => {
  it(
    "refuses a held gather on the tool call, even when failures go inbound, binding no request post",
    refusesAHeldGatherOnTheToolCall,
  );
  it(
    "binds every request post of a gather a guidance-mode check would hold",
    bindsAShadowGatherInGuidanceMode,
  );
  it(
    "refuses a gather after two stale captures without binding a request post",
    refusesAGatherAfterStaleCaptures,
  );
  it(
    "checks an all_gather's group post as its question and binds nothing when held",
    checksAnAllGatherAsItsQuestion,
  );
  it(
    "keeps a request open after its answer is refused, and replays the refusal under its key",
    keepsARequestOpenAfterARefusedAnswer,
  );
  it(
    "binds a request post only against its operation's admitted check, with exactly the content it judged",
    bindsARequestPostOnlyAgainstItsAdmittedCheck,
  );
  it(
    "refuses an answer whose request expires during its check, keeping the check's judgment",
    refusesAnAnswerWhoseRequestExpiresDuringItsCheck,
  );
  it("fails a gather whose deadline passes during its check, posting nothing", () =>
    failsWhenTheDeadlinePassesDuringTheCheck("gather"));
  it("fails an all_gather whose deadline passes during its check, posting nothing", () =>
    failsWhenTheDeadlinePassesDuringTheCheck("all_gather"));
  it(
    "refuses a held all_gather on its check alone, never opening it",
    refusesAHeldAllGatherWithoutOpeningIt,
  );
  it(
    "binds nothing when the daemon stops during a gather's check",
    bindsNothingWhenStoppedDuringAGatherCheck,
  );
});
