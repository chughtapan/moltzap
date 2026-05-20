import { beforeEach, expect, it, vi } from "vitest";
import { Effect } from "effect";

import {
  AFTER_MARKER_TEXT,
  DENIED_LEASE_ID,
  FIRST_TEXT,
  MARKER_LEASE_ID,
  OLD_DISCUSSION_TEXT,
  SECOND_TEXT,
  STUCK_MESSAGE_LEASE_TIMEOUT_MS,
  TIME_TO_VOTE_TEXT,
  agent,
  buildMessage,
  conversation,
  createChannelCoreFixture,
  createFakeChannelService,
  customSetup,
  effectTest,
  flushDispatchChainEffect,
  forceResolveAgentNamePath,
  installAdmission,
  message,
  testLeaseId,
  type ChannelCoreFixture,
  type ChannelService,
  type EnrichedInboundMessage,
  MoltZapChannelCore,
  RpcServerError,
} from "./channel-core-test-support.js";

let fake: ChannelCoreFixture["fake"];
let core: ChannelCoreFixture["core"];

beforeEach(() => {
  ({ fake, core } = createChannelCoreFixture());
});

type PendingDispatchEntry = { readonly messageId: string };
type FakeChannelCoreService = ChannelCoreFixture["fake"];
type ReceivedMessages = readonly EnrichedInboundMessage[];
type ResumeSlot = { resume: () => void };
type NameResolver = (name: string) => void;
type TextMessageSpec = {
  readonly id: string;
  readonly senderId: string;
  readonly conversationId: string;
  readonly text: string;
};
type AdmissionRequestRecord = {
  readonly messageId: string;
  readonly conversationId: string;
  readonly pending: ReadonlyArray<string>;
};

type CoalescedMessageExpectation = {
  readonly id: string;
  readonly includes: readonly string[];
  readonly coalescedIds: readonly string[];
  readonly excludes?: readonly string[];
  readonly dispatchLeaseId?: string;
};

const pendingMessageId = (entry: PendingDispatchEntry): string =>
  entry.messageId;

const receivedMessageId = (entry: { readonly id: string }): string => entry.id;

const createResumeSlot = (): ResumeSlot => ({ resume: () => undefined });

const waitForResumeSlot = (slot: ResumeSlot) =>
  Effect.async<void>((resume) => {
    slot.resume = () => resume(Effect.void);
  });

const queuedResolveAgentName =
  (resolvers: NameResolver[]) =>
  (id: string): Effect.Effect<string> =>
    Effect.async<string>((resume) => {
      resolvers.push(() => resume(Effect.succeed(id)));
    });

const waitForHandlerBarrier = (handlerBarriers: Array<() => void>) =>
  Effect.async<void>((resume) => {
    handlerBarriers.push(() => resume(Effect.void));
  });

function setGroupConversation(
  fake: FakeChannelCoreService,
  conversationId: string,
): void {
  fake.state.setConversation(conversationId, {
    type: "group",
    participants: [],
  });
}

function setAgentNames(
  fake: FakeChannelCoreService,
  names: ReadonlyArray<readonly [string, string]>,
): void {
  for (const [id, name] of names) {
    fake.state.setAgentName(id, name);
  }
}

function emitTextMessage(
  fake: FakeChannelCoreService,
  spec: TextMessageSpec,
): void {
  fake.emit.message(
    buildMessage({
      id: spec.id,
      senderId: spec.senderId,
      conversationId: spec.conversationId,
      parts: [{ type: "text", text: spec.text }],
    }),
  );
}

function emitConv1TextMessage(
  fake: FakeChannelCoreService,
  id: string,
  senderId: string,
  text: string,
): void {
  emitTextMessage(fake, {
    id,
    senderId,
    conversationId: "conv-1",
    text,
  });
}

function recordReceivedMessage(
  received: EnrichedInboundMessage[],
  inbound: EnrichedInboundMessage,
): Effect.Effect<void> {
  return Effect.sync(() => {
    received.push(inbound);
  });
}

function recordReceivedMessageId(
  received: string[],
  inbound: EnrichedInboundMessage,
): Effect.Effect<void> {
  return Effect.sync(() => {
    received.push(inbound.id);
  });
}

function installReceivedRecorder(
  core: ChannelCoreFixture["core"],
  received: EnrichedInboundMessage[],
): void {
  core.onInbound((inbound) => recordReceivedMessage(received, inbound));
}

function installNonStuckMessageIdRecorder(
  core: ChannelCoreFixture["core"],
  received: string[],
): void {
  core.onInbound((inbound) =>
    inbound.id === message("msg-stuck")
      ? Effect.never
      : recordReceivedMessageId(received, inbound),
  );
}

function expectSingleCoalescedMessage(
  received: ReceivedMessages,
  expected: CoalescedMessageExpectation,
): void {
  expect(received).toHaveLength(1);
  const first = received[0]!;
  expect(first.id).toBe(message(expected.id));
  for (const text of expected.includes) {
    expect(first.text).toContain(text);
  }
  for (const text of expected.excludes ?? []) {
    expect(first.text).not.toContain(text);
  }
  expect(first.coalescedMessages?.map(receivedMessageId)).toEqual(
    expected.coalescedIds.map(message),
  );
  if (expected.dispatchLeaseId !== undefined) {
    expect(first.dispatchLeaseId).toBe(expected.dispatchLeaseId);
  }
}

function installHoldThenGrantAdmission(
  fake: FakeChannelCoreService,
  pendingSnapshots: Array<ReadonlyArray<string>>,
): () => number {
  let calls = 0;
  installAdmission(fake, (request) =>
    Effect.sync(() => {
      calls += 1;
      pendingSnapshots.push(request.pending.map(pendingMessageId));
      return calls === 1
        ? { _tag: "hold" as const, reason: "not_yet" }
        : { _tag: "grant" as const, leaseId: testLeaseId("lease-after-hold") };
    }),
  );
  return () => calls;
}

function expectHeldDispatchRefresh(
  received: ReceivedMessages,
  pendingSnapshots: ReadonlyArray<ReadonlyArray<string>>,
): void {
  expect(pendingSnapshots).toEqual([
    [message("msg-1")],
    [message("msg-1"), message("msg-2")],
  ]);
  expectSingleCoalescedMessage(received, {
    id: "msg-1",
    includes: [FIRST_TEXT, SECOND_TEXT],
    coalescedIds: ["msg-1", "msg-2"],
  });
}

function installCrossConversationAdmission(
  fake: FakeChannelCoreService,
  requests: AdmissionRequestRecord[],
): void {
  installAdmission(fake, (request) =>
    Effect.sync(() => {
      requests.push({
        messageId: request.message.id,
        conversationId: request.conversationId,
        pending: request.pending.map(pendingMessageId),
      });
      if (request.conversationId === conversation("town-square")) {
        return { _tag: "hold" as const, reason: "town_square_night" };
      }
      return { _tag: "grant" as const, leaseId: DENIED_LEASE_ID };
    }),
  );
}

function expectCrossConversationAdmissionRequests(
  requests: ReadonlyArray<AdmissionRequestRecord>,
): void {
  expect(requests).toEqual([
    {
      messageId: message("town-night-narration"),
      conversationId: conversation("town-square"),
      pending: [message("town-night-narration")],
    },
    {
      messageId: message("den-kill-prompt"),
      conversationId: conversation("werewolf-den"),
      pending: [message("den-kill-prompt"), message("town-night-narration")],
    },
  ]);
}

function installDelayedGrantAdmission(
  fake: FakeChannelCoreService,
  pendingSnapshots: Array<ReadonlyArray<PendingDispatchEntry>>,
  grant: ResumeSlot,
): void {
  installAdmission(fake, (request) =>
    Effect.gen(function* () {
      pendingSnapshots.push(request.pending);
      yield* waitForResumeSlot(grant);
      return { _tag: "grant" as const, leaseId: testLeaseId("lease-next") };
    }),
  );
}

function installDelayedMarkerAdmission(
  fake: FakeChannelCoreService,
  grant: ResumeSlot,
): void {
  installAdmission(fake, () =>
    Effect.gen(function* () {
      yield* waitForResumeSlot(grant);
      return {
        _tag: "grant" as const,
        leaseId: MARKER_LEASE_ID,
        dispatchMessageId: message("msg-marker"),
      };
    }),
  );
}

function expectOnePendingSnapshot(
  pendingSnapshots: ReadonlyArray<ReadonlyArray<PendingDispatchEntry>>,
): void {
  expect(
    pendingSnapshots.map((snapshot) => snapshot.map(pendingMessageId)),
  ).toEqual([[message("msg-1")]]);
}

function asksOptionalDispatchAdmissionBeforeDeliveringInboundWork() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    const requests: Array<{ messageId: string; attempt: number }> = [];
    installAdmission(fake, (request) =>
      Effect.sync(() => {
        requests.push({
          messageId: request.message.id,
          attempt: request.attempt,
        });
        return { _tag: "grant" as const, leaseId: testLeaseId("lease-1") };
      }),
    );

    fake.emit.message(buildMessage({ id: "msg-1" }));
    yield* flushDispatchChainEffect;

    expect(requests).toEqual([{ messageId: message("msg-1"), attempt: 0 }]);
    expect(received.map((m) => m.id)).toEqual([message("msg-1")]);
  });
}

effectTest(
  "asks optional dispatch admission before delivering inbound work",
  asksOptionalDispatchAdmissionBeforeDeliveringInboundWork,
);

function reportsAPerConversationObservedLogicalClockToAdmission() {
  return Effect.gen(function* () {
    const { fake } = customSetup();
    const clocks: unknown[] = [];
    installAdmission(fake, (request) =>
      Effect.sync(() => {
        clocks.push(request.clock);
        expect(request.pending[0]?.clock).toEqual(request.clock);
        return { _tag: "grant" as const };
      }),
    );

    fake.emit.message(
      buildMessage({
        id: "msg-1",
        senderId: "agent-alice",
        conversationId: "conv-1",
      }),
    );
    yield* flushDispatchChainEffect;
    fake.emit.message(
      buildMessage({
        id: "msg-2",
        senderId: "agent-bob",
        conversationId: "conv-1",
      }),
    );
    yield* flushDispatchChainEffect;

    expect(clocks).toEqual([
      {
        domainId: conversation("conv-1"),
        epoch: 1,
        vector: { [agent("agent-alice")]: 1 },
      },
      {
        domainId: conversation("conv-1"),
        epoch: 2,
        vector: { [agent("agent-alice")]: 1, [agent("agent-bob")]: 1 },
      },
    ]);
  });
}

effectTest(
  "reports a per-conversation observed logical clock to admission",
  reportsAPerConversationObservedLogicalClockToAdmission,
);

function attachesTheActiveDispatchLeaseToRepliesMadeDuringHandlerExecution() {
  return Effect.gen(function* () {
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    installAdmission(fake, () =>
      Effect.succeed({
        _tag: "grant" as const,
        leaseId: testLeaseId("lease-active"),
      }),
    );
    const core = new MoltZapChannelCore({ service: fake.service });
    core.onInbound((msg) =>
      core.sendReply(msg.taskId, msg.conversationId, "reply"),
    );

    fake.emit.message(buildMessage({ id: "msg-with-lease" }));
    yield* flushDispatchChainEffect;

    expect(fake.state.sent).toEqual([
      {
        taskId: expect.any(String),
        convId: conversation("conv-1"),
        text: "reply",
        dispatchLeaseId: testLeaseId("lease-active"),
      },
    ]);
  });
}

effectTest(
  "attaches the active dispatch lease to replies made during handler execution",
  attachesTheActiveDispatchLeaseToRepliesMadeDuringHandlerExecution,
);

function passesTheActiveDispatchLeaseToTheInboundHandlerForAsyncRuntimes() {
  return Effect.gen(function* () {
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    installAdmission(fake, () =>
      Effect.succeed({
        _tag: "grant" as const,
        leaseId: testLeaseId("lease-visible"),
      }),
    );
    const core = new MoltZapChannelCore({ service: fake.service });
    const leases: Array<string | undefined> = [];
    core.onInbound((msg) =>
      Effect.sync(() => {
        leases.push(msg.dispatchLeaseId);
      }),
    );

    fake.emit.message(buildMessage({ id: "msg-with-visible-lease" }));
    yield* flushDispatchChainEffect;

    expect(leases).toEqual([testLeaseId("lease-visible")]);
  });
}

effectTest(
  "passes the active dispatch lease to the inbound handler for async runtimes",
  passesTheActiveDispatchLeaseToTheInboundHandlerForAsyncRuntimes,
);

function preservesServiceBindingForDispatchAdmissionMethods() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    // Counter lives on the service object so the test asserts the
    // channel-core admission call site invokes `requestDispatch` with
    // the service as `this` (a `.bind(undefined)` would crash).
    const boundService = fake.service as ChannelService & {
      admissionCalls: number;
    };
    boundService.admissionCalls = 0;
    // Replace the install-helper-installed `requestDispatch` with a
    // method-form binding that increments via `this.admissionCalls`.
    // Channel-core MUST call `service.requestDispatch(...)` (not
    // `requestDispatch.call(undefined, ...)`); a missing receiver
    // makes `this.admissionCalls += 1` throw on null `this`.
    installAdmission(fake, () => Effect.succeed({ _tag: "grant" as const }));
    const installed = fake.service.requestDispatch!;
    fake.service.requestDispatch = function (request) {
      (this as ChannelService & { admissionCalls: number }).admissionCalls += 1;
      return installed(request);
    };

    fake.emit.message(buildMessage({ id: "msg-bound-admission" }));
    yield* flushDispatchChainEffect;

    expect(boundService.admissionCalls).toBe(1);
    expect(received.map((m) => m.id)).toEqual([message("msg-bound-admission")]);
  });
}

effectTest(
  "preserves service binding for dispatch admission methods",
  preservesServiceBindingForDispatchAdmissionMethods,
);

function dropsDeniedInboundDispatchWorkWithoutCallingTheHandler() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    installAdmission(fake, () =>
      Effect.succeed({
        _tag: "deny" as const,
        reason: "not this slot",
      }),
    );

    fake.emit.message(buildMessage({ id: "msg-denied" }));
    yield* flushDispatchChainEffect;

    expect(received).toHaveLength(0);
  });
}

effectTest(
  "drops denied inbound dispatch work without calling the handler",
  dropsDeniedInboundDispatchWorkWithoutCallingTheHandler,
);

function holdsHeadOfLineWorkUntilANewInboundMessageRefreshesTheSnapshot() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    setGroupConversation(fake, "conv-1");
    setAgentNames(fake, [
      ["agent-alice", "Alice"],
      ["agent-bob", "Bob"],
    ]);
    const pendingSnapshots: Array<ReadonlyArray<string>> = [];
    const admissionCalls = installHoldThenGrantAdmission(
      fake,
      pendingSnapshots,
    );

    emitConv1TextMessage(fake, "msg-1", "agent-alice", FIRST_TEXT);
    yield* flushDispatchChainEffect;
    expect(admissionCalls()).toBe(1);
    expect(received).toHaveLength(0);

    emitConv1TextMessage(fake, "msg-2", "agent-bob", SECOND_TEXT);
    yield* flushDispatchChainEffect;

    expectHeldDispatchRefresh(received, pendingSnapshots);
  });
}

effectTest(
  "holds head-of-line work until a new inbound message refreshes the snapshot",
  holdsHeadOfLineWorkUntilANewInboundMessageRefreshesTheSnapshot,
);

function doesNotLetHeldWorkInOneConversationBlockAnotherConversation() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    setGroupConversation(fake, "town-square");
    setGroupConversation(fake, "werewolf-den");
    fake.state.setAgentName("agent-gm", "GM");
    const requests: AdmissionRequestRecord[] = [];
    installCrossConversationAdmission(fake, requests);

    emitTextMessage(fake, {
      id: "town-night-narration",
      senderId: "agent-gm",
      conversationId: "town-square",
      text: "Night falls.",
    });
    yield* flushDispatchChainEffect;

    emitTextMessage(fake, {
      id: "den-kill-prompt",
      senderId: "agent-gm",
      conversationId: "werewolf-den",
      text: "Werewolves, choose a target.",
    });
    yield* flushDispatchChainEffect;

    expectCrossConversationAdmissionRequests(requests);
    expect(received.map((m) => m.id)).toEqual([message("den-kill-prompt")]);
    expect(received[0]!.conversationId).toBe(conversation("werewolf-den"));
    expect(received[0]!.dispatchLeaseId).toBe(DENIED_LEASE_ID);
  });
}

effectTest(
  "does not let held work in one conversation block another conversation",
  doesNotLetHeldWorkInOneConversationBlockAnotherConversation,
);

function purgesHeldAndQueuedDispatchWorkWhenAConversationIsArchived() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    fake.state.setConversation("conv-1", {
      type: "group",
      participants: [],
    });
    fake.state.setAgentName("agent-alice", "Alice");
    let calls = 0;
    installAdmission(fake, () =>
      Effect.sync(() => {
        calls += 1;
        return { _tag: "hold" as const, reason: "waiting" };
      }),
    );

    fake.emit.message(buildMessage({ id: "msg-held" }));
    yield* flushDispatchChainEffect;

    fake.emit.conversationArchived({ conversationId: "conv-1" });
    fake.emit.message(buildMessage({ id: "msg-after-archive" }));
    yield* flushDispatchChainEffect;

    expect(calls).toBe(1);
    expect(received).toHaveLength(0);
  });
}

effectTest(
  "purges held and queued dispatch work when a conversation is archived",
  purgesHeldAndQueuedDispatchWorkWhenAConversationIsArchived,
);

function keepsBlockedAuthorizationHeadOfLineAndCoalescesSameConversationBacklogOnGrant() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    setGroupConversation(fake, "conv-1");
    setAgentNames(fake, [
      ["agent-alice", "Alice"],
      ["agent-bob", "Bob"],
    ]);
    const pendingSnapshots: Array<ReadonlyArray<{ messageId: string }>> = [];
    const grant = createResumeSlot();
    installDelayedGrantAdmission(fake, pendingSnapshots, grant);

    emitConv1TextMessage(fake, "msg-1", "agent-alice", FIRST_TEXT);
    yield* flushDispatchChainEffect;
    expect(received).toHaveLength(0);
    emitConv1TextMessage(fake, "msg-2", "agent-bob", SECOND_TEXT);

    grant.resume();
    yield* flushDispatchChainEffect;

    expectOnePendingSnapshot(pendingSnapshots);
    expectSingleCoalescedMessage(received, {
      id: "msg-1",
      includes: [FIRST_TEXT, SECOND_TEXT],
      coalescedIds: ["msg-1", "msg-2"],
    });
  });
}

effectTest(
  "keeps blocked authorization head-of-line and coalesces same-conversation backlog on grant",
  keepsBlockedAuthorizationHeadOfLineAndCoalescesSameConversationBacklogOnGrant,
);

function dispatchesAnAdmittedPendingMarkerAndDropsOlderSameConversationWork() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    setGroupConversation(fake, "conv-1");
    setAgentNames(fake, [
      ["agent-alice", "Alice"],
      ["agent-gm", "GM"],
    ]);
    const grant = createResumeSlot();
    installDelayedMarkerAdmission(fake, grant);

    emitConv1TextMessage(fake, "msg-old", "agent-alice", OLD_DISCUSSION_TEXT);
    yield* flushDispatchChainEffect;
    emitConv1TextMessage(fake, "msg-marker", "agent-gm", TIME_TO_VOTE_TEXT);
    emitConv1TextMessage(fake, "msg-after", "agent-alice", AFTER_MARKER_TEXT);

    grant.resume();
    yield* flushDispatchChainEffect;

    expectSingleCoalescedMessage(received, {
      id: "msg-marker",
      includes: [TIME_TO_VOTE_TEXT, AFTER_MARKER_TEXT],
      excludes: [OLD_DISCUSSION_TEXT],
      coalescedIds: ["msg-marker", "msg-after"],
      dispatchLeaseId: MARKER_LEASE_ID,
    });
  });
}

effectTest(
  "dispatches an admitted pending marker and drops older same-conversation work",
  dispatchesAnAdmittedPendingMarkerAndDropsOlderSameConversationWork,
);

function failsClosedWhenDispatchAdmissionErrors() {
  return Effect.gen(function* () {
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const received: EnrichedInboundMessage[] = [];
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    const core = new MoltZapChannelCore({
      service: fake.service,
    });
    installReceivedRecorder(core, received);
    installAdmission(fake, () =>
      Effect.fail(
        new RpcServerError({
          code: -32603,
          message: "admission service unavailable",
        }),
      ),
    );

    fake.emit.message(buildMessage({ id: "msg-fail-closed" }));
    yield* flushDispatchChainEffect;

    expect(received).toHaveLength(0);
  });
}

effectTest(
  "fails closed when dispatch admission errors",
  failsClosedWhenDispatchAdmissionErrors,
);

it("fails closed when dispatch admission hangs", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fake = createFakeChannelService({ ownAgentId: "agent-self" });
      const received: EnrichedInboundMessage[] = [];
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");
      const core = new MoltZapChannelCore({
        service: fake.service,
        dispatchAdmissionTimeoutMs: 1,
      });
      installReceivedRecorder(core, received);
      installAdmission(fake, () => Effect.never);

      fake.emit.message(buildMessage({ id: "msg-timeout-closed" }));

      yield* Effect.sleep(10);
      yield* flushDispatchChainEffect;

      expect(received).toHaveLength(0);
    }),
  ));

it("continues draining inbound work after a dispatch lease expires", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fake = createFakeChannelService({ ownAgentId: "agent-self" });
      const received: string[] = [];
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");
      installAdmission(fake, (request) =>
        Effect.succeed({
          _tag: "grant" as const,
          leaseId: testLeaseId(`lease-${request.message.id}`),
          leaseTimeoutMs:
            request.message.id === message("msg-stuck")
              ? 1
              : STUCK_MESSAGE_LEASE_TIMEOUT_MS,
        }),
      );
      const core = new MoltZapChannelCore({
        service: fake.service,
      });
      installNonStuckMessageIdRecorder(core, received);

      fake.emit.message(buildMessage({ id: "msg-stuck" }));
      yield* flushDispatchChainEffect;
      fake.emit.message(buildMessage({ id: "msg-next" }));
      yield* Effect.sleep(10);
      yield* flushDispatchChainEffect;

      expect(received).toEqual([message("msg-next")]);
    }),
  ));

function serializesHandlersSoMessageOrderIsPreservedAcrossAsyncResolution() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    forceResolveAgentNamePath(fake);

    // Hold the resolveAgentName promises so we can control timing. The
    // fake returns an async-style Effect that resumes once the test calls
    // the recorded resolver — this mirrors the pre-Effect Promise flow.
    const resolvers: NameResolver[] = [];
    fake.service.resolveAgentName = queuedResolveAgentName(resolvers);

    fake.emit.message(buildMessage({ id: "msg-1" }));
    fake.emit.message(buildMessage({ id: "msg-2" }));

    // Neither has been delivered to the handler yet — first message is
    // still awaiting resolveAgentName; second is queued behind it.
    yield* flushDispatchChainEffect;
    expect(received).toHaveLength(0);
    expect(resolvers).toHaveLength(1);

    // Resolve the first, chain advances.
    resolvers[0]!("agent-alice");
    yield* flushDispatchChainEffect;
    expect(received.map((r) => r.id)).toEqual([message("msg-1")]);
    expect(resolvers).toHaveLength(2);

    // Resolve the second.
    resolvers[1]!("agent-bob");
    yield* flushDispatchChainEffect;
    expect(received.map((r) => r.id)).toEqual([
      message("msg-1"),
      message("msg-2"),
    ]);
  });
}

effectTest(
  "serializes handlers so message order is preserved across async resolution",
  serializesHandlersSoMessageOrderIsPreservedAcrossAsyncResolution,
);

function awaitsAsyncHandlerFullyBeforeProcessingTheNextMessage() {
  return Effect.gen(function* () {
    const { fake, core } = customSetup();
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");

    const handlerBarriers: Array<() => void> = [];
    const order: string[] = [];

    core.onInbound((m) =>
      Effect.gen(function* () {
        order.push(`enter:${m.id}`);
        yield* waitForHandlerBarrier(handlerBarriers);
        order.push(`exit:${m.id}`);
      }),
    );

    fake.emit.message(buildMessage({ id: "msg-1" }));
    fake.emit.message(buildMessage({ id: "msg-2" }));
    yield* flushDispatchChainEffect;

    // Handler started for msg-1, hasn't returned yet. msg-2 has NOT entered.
    expect(order).toEqual([`enter:${message("msg-1")}`]);

    handlerBarriers[0]!();
    yield* flushDispatchChainEffect;

    // msg-1 fully processed; msg-2 has entered.
    expect(order).toEqual([
      `enter:${message("msg-1")}`,
      `exit:${message("msg-1")}`,
      `enter:${message("msg-2")}`,
    ]);

    handlerBarriers[1]!();
    yield* flushDispatchChainEffect;
    expect(order).toEqual([
      `enter:${message("msg-1")}`,
      `exit:${message("msg-1")}`,
      `enter:${message("msg-2")}`,
      `exit:${message("msg-2")}`,
    ]);
  });
}

effectTest(
  "awaits async handler fully before processing the next message",
  awaitsAsyncHandlerFullyBeforeProcessingTheNextMessage,
);

function onInboundReplacesThePreviousHandlerInsteadOfAdding() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");

    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    core.onInbound((m) => Effect.sync(() => firstHandler(m)));
    core.onInbound((m) => Effect.sync(() => secondHandler(m)));

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledOnce();
  });
}

effectTest(
  "onInbound replaces the previous handler instead of adding",
  onInboundReplacesThePreviousHandlerInsteadOfAdding,
);
