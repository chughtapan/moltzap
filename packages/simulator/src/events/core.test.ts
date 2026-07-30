import { assert, effect as test } from "@effect/vitest";
import { Effect, Either } from "effect";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  coreEvents,
  endpointEvents,
  linkEvents,
  RouterMessageCommitted,
  routerEvents,
  runEvents,
  runtimeEvents,
} from "./core.js";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const TASK_ID = "550e8400-e29b-41d4-a716-446655440001";
const CONVERSATION_ID = "550e8400-e29b-41d4-a716-446655440002";
const MESSAGE_ID = "550e8400-e29b-41d4-a716-446655440003";

test("declares one exact versioned core event universe", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(coreEvents.tags, [
      ...runEvents.tags,
      ...routerEvents.tags,
      ...runtimeEvents.tags,
      ...endpointEvents.tags,
      ...linkEvents.tags,
    ]);
    assert.isTrue(coreEvents.tags.every((tag) => tag.endsWith("/v1")));
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
      taskId: TASK_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      senderId: AGENT_ID,
      routerSequence: 0,
    });
    const contentBearing = yield* coreEvents
      .decode({
        _tag: "moltzap.router-message-committed/v1",
        taskId: TASK_ID,
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
