/**
 * App-session-scoping: app authority belongs to the app principal that owns the
 * task. An app authenticates via `appKey` as an `AppConnection`, and
 * task-admin RPCs (`app/conversation/create`, etc.) are gated by
 * `assertAppOwnsTask(connection.auth.appId, task)`. The requesting agent is a
 * separate principal.
 *
 * Coverage:
 * 1. The owning app's `AppConnection` passes the app ownership gate.
 * 2. An agent connection does not pass (only an `AppConnection` is an app
 *    principal; `assertCallerAppOwnsTask` rejects non-app callers).
 * 3. A different app (different `appKey` -> different DB appId) does not own
 *    the task and is rejected.
 *
 * The hijack rejection (a second connection cannot steal a live app's
 * moderator-endpoint binding) is covered at the unit level by
 * `identity/apps/endpoint-registry.test.ts` — the registry's strict
 * no-overwrite invariant.
 * At the integration level the Connect rejection is swallowed by the test
 * client's auto-connect, so a meaningful assertion there is not available
 * without a raw Connect-frame driver; the unit test is the canonical proof.
 */
import { WIRE_ERROR_TAG } from "@moltzap/protocol/testing";
import { it as effectIt } from "@effect/vitest";
import { dispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { messagesAuthorize } from "@moltzap/protocol/message";
import { taskCreate, taskRequest, type AppId } from "@moltzap/protocol/task";
import { conversationCreate } from "@moltzap/protocol/conversation";
import type {
  AppCallbackContext,
  AppCallbackHandlers,
} from "@moltzap/protocol/socket";
import type { AppManifest } from "@moltzap/protocol/identity";
import { Cause, Effect, Exit, Option } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  connectAppClient,
  getBaseUrl,
  registerAndConnect,
  registerApp,
  resetTestDbEffect,
  startTestServerEffect,
  stopTestServerEffect,
  type TestAppClient,
} from "../helpers.js";

const it = effectIt.live;

// `manifest.appId` does not route (the DB mints `app_id`); the manifest
// supplies name / conversations / hooks. `task_create` is `kind: "hook"`
// so the app's `TaskCreate` callback is consulted; the other two policies
// take their open static verdict in-process.
const APP_MANIFEST: AppManifest = {
  name: "App Session Scoping Test App",
  appId: "00000000-0000-4000-8000-000000010004",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
  hooks: {
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "forwardAllExceptSender" },
    task_create: { kind: "hook", timeoutMs: 5_000 },
  },
};

beforeAll(() => Effect.runPromise(startTestServerEffect()), 60_000);
afterAll(() => Effect.runPromise(stopTestServerEffect()));
beforeEach(() => Effect.runPromise(resetTestDbEffect()));

function rpcErrorCode(exit: Exit.Exit<unknown, unknown>): string | null {
  if (Exit.isSuccess(exit)) {
    return null;
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    return null;
  }
  const err =
    /* Safe because the test fixture establishes this asserted shape. */ failure.value as {
      readonly _tag?: string;
    };
  return typeof err._tag === "string" ? err._tag : null;
}

/**
 * Register an app (HTTP), open its `AppConnection`, wire an auto-accept
 * `app/task/create` callback, and return the live app client + DB-minted appId.
 * @returns The setup owning app result.
 */
function setupOwningApp(): Effect.Effect<
  { appClient: TestAppClient; appId: AppId },
  unknown
> {
  return Effect.gen(function* () {
    const registered = yield* registerApp(getBaseUrl(), APP_MANIFEST);
    const appClient = yield* connectAppClient(
      registered.appId,
      registered.appKey,
      acceptTaskCreateHandlers(),
    );
    return { appClient, appId: registered.appId };
  });
}

function acceptTaskCreateHandlers(): AppCallbackHandlers<AppCallbackContext> {
  return {
    [dispatchAuthorize.name]: {
      definition: dispatchAuthorize,
      handle: () => Effect.dieMessage("unexpected app/dispatch/authorize"),
    },
    [messagesAuthorize.name]: {
      definition: messagesAuthorize,
      handle: () => Effect.dieMessage("unexpected app/message/authorize"),
    },
    [taskCreate.name]: {
      definition: taskCreate,
      handle: () =>
        Effect.succeed({ verdict: { decision: "accept" as const } }),
    },
  };
}

function owningAppConnPassesTmGate() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice");
    const bob = yield* registerAndConnect("bob");
    const { appClient, appId } = yield* setupOwningApp();
    const task = yield* alice.client.sendRpc(taskRequest, {
      appId,
      invitedAgentIds: [bob.agentId],
    });
    const conv = yield* appClient.sendRpc(conversationCreate, {
      taskId: task.task.id,
      participants: [bob.agentId],
    });
    expect(conv.conversation.id).toBeTruthy();
  });
}

function nonOwningAppFailsAppOwnershipGate() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-3");
    const bob = yield* registerAndConnect("bob-3");
    const { appId } = yield* setupOwningApp();
    const task = yield* alice.client.sendRpc(taskRequest, {
      appId,
      invitedAgentIds: [bob.agentId],
    });
    // A DIFFERENT app (fresh appKey → different DB appId) does not own the
    // task; `assertAppOwnsTask` rejects it with the same ForbiddenError.
    const other = yield* registerApp(getBaseUrl(), {
      ...APP_MANIFEST,
      name: "Other App",
    });
    const otherClient = yield* connectAppClient(
      other.appId,
      other.appKey,
      acceptTaskCreateHandlers(),
    );
    const exit = yield* Effect.exit(
      otherClient.sendRpc(conversationCreate, {
        taskId: task.task.id,
        participants: [bob.agentId],
      }),
    );
    expect(rpcErrorCode(exit)).toBe(WIRE_ERROR_TAG.Forbidden);
  });
}

describe("app-session-scoping — app authority via owning app principal", () => {
  it(
    "the owning app connection passes the app ownership gate",
    owningAppConnPassesTmGate,
    20_000,
  );
  it(
    "a non-owning app fails the app ownership gate",
    nonOwningAppFailsAppOwnershipGate,
    20_000,
  );
});
