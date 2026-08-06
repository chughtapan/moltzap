import { assert, effect as test } from "@effect/vitest";
import { Effect, Either, Schema } from "effect";
import { EventCatalog, EventCatalogDefinitionError } from "./catalog.js";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  coreEvents,
  endpointEvents,
  EndpointMessageReceived,
  EndpointMessageSent,
  linkEvents,
  LinkMessageDelayed,
  LinkMessageDropped,
  LinkMessageHeld,
  LinkPolicyCleared,
  LinkPolicySet,
  RouterMessageCommitted,
  routerEvents,
  runEvents,
  runtimeEvents,
} from "./core.js";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const PEER_ID = "550e8400-e29b-41d4-a716-446655440001";
const CONVERSATION_ID = "550e8400-e29b-41d4-a716-446655440002";
const MESSAGE_ID = "550e8400-e29b-41d4-a716-446655440003";
const POLICY_DESCRIPTION = "delay 100 millis";
const DROP_REASON = "partition";
const DELAY_MILLIS = 100;
const MISCASED_TAG_FAILURE = "invalid-tag";
const DUPLICATE_TAG_FAILURE = "duplicate-tag";

// The tag type admits both of these; only the tag schema rejects them.
class MiscasedTagEvent extends Schema.TaggedClass<MiscasedTagEvent>()(
  "Acme.Miscased/v1",
  {},
) {}
class UnversionedTagEvent extends Schema.TaggedClass<UnversionedTagEvent>()(
  "acme.unversioned/v0",
  {},
) {}

function catalogFailure(build: () => unknown): EventCatalogDefinitionError {
  try {
    build();
  } catch (cause) {
    if (cause instanceof EventCatalogDefinitionError) {
      return cause;
    }
    throw cause;
  }
  throw new Error("the catalog was accepted");
}

// @agent-code-guard/regression-only: decode round-trips pin the exact persisted event universe and field schemas
test("declares one exact versioned core event universe", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(coreEvents.tags, [
      ...runEvents.tags,
      ...routerEvents.tags,
      ...runtimeEvents.tags,
      ...endpointEvents.tags,
      ...linkEvents.tags,
    ]);
    assert.deepStrictEqual(endpointEvents.tags, [
      "moltzap.conversation-opened/v1",
      EndpointMessageSent._tag,
      EndpointMessageReceived._tag,
    ]);
    assert.deepStrictEqual(linkEvents.tags, [
      "moltzap.link-down/v1",
      "moltzap.link-up/v1",
      LinkPolicySet._tag,
      LinkPolicyCleared._tag,
      LinkMessageDropped._tag,
      LinkMessageDelayed._tag,
      LinkMessageHeld._tag,
    ]);
    assert.isTrue(coreEvents.tags.every((tag) => /\/v\d+$/u.test(tag)));
  }));

test("rejects the tag spellings the tag type cannot exclude", () =>
  Effect.sync(() => {
    const miscased = catalogFailure(() => EventCatalog.make(MiscasedTagEvent));
    const unversioned = catalogFailure(() =>
      EventCatalog.make(UnversionedTagEvent),
    );
    const duplicate = catalogFailure(() =>
      EventCatalog.make(LinkPolicySet, LinkPolicySet),
    );

    assert.strictEqual(miscased.failure, MISCASED_TAG_FAILURE);
    assert.strictEqual(miscased.tag, MiscasedTagEvent._tag);
    assert.strictEqual(unversioned.failure, MISCASED_TAG_FAILURE);
    assert.strictEqual(duplicate.failure, DUPLICATE_TAG_FAILURE);
    assert.strictEqual(duplicate.tag, LinkPolicySet._tag);
  }));

test("round-trips described link-policy evidence", () =>
  Effect.gen(function* () {
    const set = yield* coreEvents.decode({
      _tag: "moltzap.link-policy-set/v1",
      from: AGENT_ID,
      to: PEER_ID,
      policy: POLICY_DESCRIPTION,
    });
    const cleared = yield* coreEvents.decode({
      _tag: "moltzap.link-policy-cleared/v1",
      from: AGENT_ID,
      to: PEER_ID,
      policy: POLICY_DESCRIPTION,
    });
    const anonymousPolicy = yield* coreEvents
      .decode({
        _tag: "moltzap.link-policy-set/v1",
        from: AGENT_ID,
        to: PEER_ID,
        policy: "",
      })
      .pipe(Effect.either);

    assert.instanceOf(set, LinkPolicySet);
    assert.strictEqual(set.policy, POLICY_DESCRIPTION);
    assert.instanceOf(cleared, LinkPolicyCleared);
    assert.isTrue(linkEvents.hasEvent(set));
    assert.isTrue(
      Either.match(anonymousPolicy, {
        onLeft: () => true,
        onRight: () => false,
      }),
    );
  }));

test("round-trips per-message link delivery evidence", () =>
  Effect.gen(function* () {
    const dropped = yield* coreEvents.decode({
      _tag: "moltzap.link-message-dropped/v1",
      from: AGENT_ID,
      to: PEER_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      reason: DROP_REASON,
    });
    const droppedWithoutReason = yield* coreEvents.decode({
      _tag: "moltzap.link-message-dropped/v1",
      from: AGENT_ID,
      to: PEER_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
    });
    const delayed = yield* coreEvents.decode({
      _tag: "moltzap.link-message-delayed/v1",
      from: AGENT_ID,
      to: PEER_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      delayMillis: DELAY_MILLIS,
    });
    const held = yield* coreEvents.decode({
      _tag: "moltzap.link-message-held/v1",
      from: AGENT_ID,
      to: PEER_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
    });

    assert.instanceOf(dropped, LinkMessageDropped);
    assert.strictEqual(dropped.reason, DROP_REASON);
    assert.instanceOf(droppedWithoutReason, LinkMessageDropped);
    assert.isUndefined(droppedWithoutReason.reason);
    assert.instanceOf(delayed, LinkMessageDelayed);
    assert.strictEqual(delayed.delayMillis, DELAY_MILLIS);
    assert.instanceOf(held, LinkMessageHeld);
  }));

test("represents process exit and signal as distinct classes", () =>
  Effect.gen(function* () {
    const exited = yield* coreEvents.decode({
      _tag: "moltzap.agent-process-exited/v1",
      agentName: "alice",
      agentId: AGENT_ID,
      runtime: "openclaw",
      code: 0,
    });
    const signaled = yield* coreEvents.decode({
      _tag: "moltzap.agent-process-signaled/v1",
      agentName: "alice",
      agentId: AGENT_ID,
      runtime: "openclaw",
      signal: "SIGTERM",
    });
    const ambiguous = yield* coreEvents
      .decode({
        _tag: "moltzap.agent-process-exited/v1",
        agentName: "alice",
        agentId: AGENT_ID,
        runtime: "openclaw",
        code: 0,
        signal: "SIGTERM",
      })
      .pipe(Effect.either);

    assert.instanceOf(exited, AgentProcessExited);
    assert.instanceOf(signaled, AgentProcessSignaled);
    assert.isTrue(
      Either.match(ambiguous, {
        onLeft: () => true,
        onRight: () => false,
      }),
    );
  }));

test("keeps router commitment evidence content-blind", () =>
  Effect.gen(function* () {
    const committed = yield* coreEvents.decode({
      _tag: "moltzap.router-message-committed/v1",
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      senderId: AGENT_ID,
      routerSequence: 0,
    });
    const contentBearing = yield* coreEvents
      .decode({
        _tag: "moltzap.router-message-committed/v1",
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        senderId: AGENT_ID,
        routerSequence: 0,
        parts: [{ type: "text", text: "router plaintext" }],
      })
      .pipe(Effect.either);

    assert.instanceOf(committed, RouterMessageCommitted);
    assert.isTrue(
      Either.match(contentBearing, {
        onLeft: () => true,
        onRight: () => false,
      }),
    );
  }));
