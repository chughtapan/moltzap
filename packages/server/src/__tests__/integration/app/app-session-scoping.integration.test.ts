/**
 * App-session-scoping: the calling WS connection IS the registered
 * remote-app connection for `tasks.app_id`. `#673` made this the proof
 * that drives TM-authority — this suite asserts it end-to-end.
 *
 * Coverage:
 * 1. Registered remote-app connection passes the TM gate.
 * 2. A peer WS connection (different conn, different agent) does NOT.
 * 3. Closing the moderator connection drops the registration; a
 *    follow-up call from a fresh connection without re-registering fails.
 * 4. Re-registering the same app on a NEW connection replaces the
 *    binding; the new connection passes the gate, the prior one no
 *    longer does.
 */
import { it as effectIt } from "@effect/vitest";
import {
  AppsRegister,
  TaskConversationCreate,
  TaskCreate,
  type AppId,
  type AppManifest,
  ForbiddenError,
} from "@moltzap/protocol";
import { Cause, Effect, Exit } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  registerAndConnect,
  resetTestDbEffect,
  startTestServerEffect,
  stopTestServerEffect,
} from "../helpers.js";

const it = effectIt.live;

const APP_ID = "00000000-0000-4000-8000-000000010004" as AppId;
const APP_MANIFEST: AppManifest = {
  appId: APP_ID,
  name: "App Session Scoping Test App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

beforeAll(() => Effect.runPromise(startTestServerEffect()), 60_000);
afterAll(() => Effect.runPromise(stopTestServerEffect()));
beforeEach(() => Effect.runPromise(resetTestDbEffect()));

function rpcErrorCode(exit: Exit.Exit<unknown, unknown>): number | null {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") return null;
  const err = failure.value as { readonly code?: unknown };
  return typeof err.code === "number" ? err.code : null;
}

function registeredAppConnPassesTmGate() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice");
    const bob = yield* registerAndConnect("bob");
    yield* alice.client.sendRpc(AppsRegister, { manifest: APP_MANIFEST });
    const task = yield* alice.client.sendRpc(TaskCreate, {
      appId: APP_ID,
      invitedAgentIds: [bob.agentId],
    });
    const conv = yield* alice.client.sendRpc(TaskConversationCreate, {
      taskId: task.task.id,
      participants: [bob.agentId],
    });
    expect(conv.conversation.taskId).toBe(task.task.id);
  });
}

function peerConnFailsTmGate() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-2");
    const bob = yield* registerAndConnect("bob-2");
    yield* alice.client.sendRpc(AppsRegister, { manifest: APP_MANIFEST });
    const task = yield* alice.client.sendRpc(TaskCreate, {
      appId: APP_ID,
      invitedAgentIds: [bob.agentId],
    });
    const exit = yield* Effect.exit(
      bob.client.sendRpc(TaskConversationCreate, {
        taskId: task.task.id,
        participants: [bob.agentId],
      }),
    );
    expect(rpcErrorCode(exit)).toBe(ForbiddenError.code);
  });
}

function disconnectDropsRegistration() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-3");
    const bob = yield* registerAndConnect("bob-3");
    yield* alice.client.sendRpc(AppsRegister, { manifest: APP_MANIFEST });
    const task = yield* alice.client.sendRpc(TaskCreate, {
      appId: APP_ID,
      invitedAgentIds: [bob.agentId],
    });
    yield* alice.client.close();
    // Alice's registration is gone; a fresh connection (without
    // re-registering) cannot pass the TM gate.
    const alice2 = yield* registerAndConnect("alice-3b");
    const exit = yield* Effect.exit(
      alice2.client.sendRpc(TaskConversationCreate, {
        taskId: task.task.id,
        participants: [bob.agentId],
      }),
    );
    expect(rpcErrorCode(exit)).toBe(ForbiddenError.code);
  });
}

function reregisterReplacesBinding() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-4");
    const bob = yield* registerAndConnect("bob-4");
    yield* alice.client.sendRpc(AppsRegister, { manifest: APP_MANIFEST });
    const task = yield* alice.client.sendRpc(TaskCreate, {
      appId: APP_ID,
      invitedAgentIds: [bob.agentId],
    });
    // New connection re-registers the same app; takes over the binding.
    const alice2 = yield* registerAndConnect("alice-4b");
    yield* alice2.client.sendRpc(AppsRegister, { manifest: APP_MANIFEST });
    // The new connection passes the gate.
    const conv = yield* alice2.client.sendRpc(TaskConversationCreate, {
      taskId: task.task.id,
      participants: [bob.agentId],
    });
    expect(conv.conversation.taskId).toBe(task.task.id);
    // The OLD connection no longer passes the gate (its registration
    // was overwritten).
    const exit = yield* Effect.exit(
      alice.client.sendRpc(TaskConversationCreate, {
        taskId: task.task.id,
        participants: [bob.agentId],
      }),
    );
    expect(rpcErrorCode(exit)).toBe(ForbiddenError.code);
  });
}

describe("app-session-scoping — TM authority via remote-app connection", () => {
  it(
    "registered app connection passes the TM gate",
    registeredAppConnPassesTmGate,
    20_000,
  );
  it("peer connection fails the TM gate", peerConnFailsTmGate, 20_000);
  it("disconnect drops the registration", disconnectDropsRegistration, 20_000);
  it(
    "re-register on new connection replaces the prior binding",
    reregisterReplacesBinding,
    20_000,
  );
});
