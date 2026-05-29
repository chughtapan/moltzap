/**
 * App-session-scoping: TM authority belongs to the APP principal that owns
 * the task. D #705 CP9 dissolved the cross-principal "the calling WS
 * connection IS the moderator" model: an app authenticates via `appKey`
 * (a disjoint `AppConnection`), and task-admin RPCs (`task/conversation/create`
 * etc.) are gated by `assertAppOwnsTask(connection.auth.appId, task)` — NOT by
 * a live registration. The requesting agent is a separate principal.
 *
 * Coverage:
 * 1. The owning app's `AppConnection` passes the TM gate.
 * 2. An AGENT connection does NOT (only an `AppConnection` is an app
 *    principal; `assertCallerAppOwnsTask` rejects non-app callers).
 * 3. A DIFFERENT app (different `appKey` → different DB appId) does not own
 *    the task and is rejected.
 *
 * The hijack rejection (a second connection cannot steal a live app's
 * moderator-endpoint binding) is covered at the unit level by
 * `app-host.remote.test.ts` — the registry's strict no-overwrite invariant.
 * At the integration level the Connect rejection is swallowed by the test
 * client's auto-connect, so a meaningful assertion there is not available
 * without a raw Connect-frame driver; the unit test is the canonical proof.
 */
import { it as effectIt } from "@effect/vitest";
import {
  TaskCreate,
  TaskConversationCreate,
  TaskRequest,
  type AppManifest,
  ForbiddenError,
} from "@moltzap/protocol";
import { Cause, Effect, Exit } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  connectAppClient,
  getBaseUrl,
  registerAndConnect,
  registerApp,
  resetTestDbEffect,
  startTestServerEffect,
  stopTestServerEffect,
  type ServerTestClient,
} from "../helpers.js";

const it = effectIt.live;

// D #705 CP9 — `manifest.appId` no longer routes (the DB mints `app_id`);
// the manifest supplies only name/conversations/hooks. The `task_create`
// hook is declared so the app's `TaskCreate` callback is consulted (a
// hookless manifest auto-accepts server-side).
const APP_MANIFEST: AppManifest = {
  name: "App Session Scoping Test App",
  appId: "00000000-0000-4000-8000-000000010004",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
  hooks: { task_create: {} },
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

/**
 * Register an app (HTTP), open its `AppConnection`, wire an auto-accept
 * `task/create` callback, and return the live app client + DB-minted appId.
 */
function setupOwningApp(): Effect.Effect<
  { appClient: ServerTestClient; appId: string },
  unknown
> {
  return Effect.gen(function* () {
    const registered = yield* registerApp(getBaseUrl(), APP_MANIFEST);
    const appClient = yield* connectAppClient(registered.appKey);
    yield* appClient.onAppCallback(TaskCreate, () =>
      Effect.succeed({ verdict: { decision: "accept" as const } }),
    );
    return { appClient, appId: registered.appId };
  });
}

function owningAppConnPassesTmGate() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice");
    const bob = yield* registerAndConnect("bob");
    const { appClient, appId } = yield* setupOwningApp();
    const task = yield* alice.client.sendRpc(TaskRequest, {
      appId,
      invitedAgentIds: [bob.agentId],
    });
    const conv = yield* appClient.sendRpc(TaskConversationCreate, {
      taskId: task.task.id,
      participants: [bob.agentId],
    });
    expect(conv.conversation.id).toBeTruthy();
  });
}

function agentConnFailsTmGate() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-2");
    const bob = yield* registerAndConnect("bob-2");
    const { appId } = yield* setupOwningApp();
    const task = yield* alice.client.sendRpc(TaskRequest, {
      appId,
      invitedAgentIds: [bob.agentId],
    });
    // An AGENT connection is not an app principal — the TM gate rejects it.
    const exit = yield* Effect.exit(
      bob.client.sendRpc(TaskConversationCreate, {
        taskId: task.task.id,
        participants: [bob.agentId],
      }),
    );
    expect(rpcErrorCode(exit)).toBe(ForbiddenError.code);
  });
}

function nonOwningAppFailsTmGate() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-3");
    const bob = yield* registerAndConnect("bob-3");
    const { appId } = yield* setupOwningApp();
    const task = yield* alice.client.sendRpc(TaskRequest, {
      appId,
      invitedAgentIds: [bob.agentId],
    });
    // A DIFFERENT app (fresh appKey → different DB appId) does not own the
    // task; `assertAppOwnsTask` rejects it with the same ForbiddenError.
    const other = yield* registerApp(getBaseUrl(), {
      ...APP_MANIFEST,
      name: "Other App",
    });
    const otherClient = yield* connectAppClient(other.appKey);
    const exit = yield* Effect.exit(
      otherClient.sendRpc(TaskConversationCreate, {
        taskId: task.task.id,
        participants: [bob.agentId],
      }),
    );
    expect(rpcErrorCode(exit)).toBe(ForbiddenError.code);
  });
}

describe("app-session-scoping — TM authority via owning app principal", () => {
  it(
    "the owning app connection passes the TM gate",
    owningAppConnPassesTmGate,
    20_000,
  );
  it("an agent connection fails the TM gate", agentConnFailsTmGate, 20_000);
  it("a non-owning app fails the TM gate", nonOwningAppFailsTmGate, 20_000);
});
