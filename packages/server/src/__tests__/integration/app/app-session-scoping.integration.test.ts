/**
 * App-session-scoping: app authority belongs to the app principal named by
 * `conversations.app_id`. An app authenticates via `appKey` as an
 * `AppConnection`, and the app-owned mutation RPCs (`app/conversation/update`)
 * are gated by `assertCallerAppOwnsConversation(connection.auth.appId,
 * conversationId)`. The participating agents are separate principals.
 *
 * Coverage:
 * 1. The owning app's `AppConnection` passes the app ownership gate.
 * 2. A different app (different `appKey` -> different DB appId) does not own
 *    the conversation and is rejected.
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
import {
  conversationCreate,
  conversationUpdate,
} from "@moltzap/protocol/conversation";
import type {
  AppCallbackContext,
  AppCallbackHandlers,
} from "@moltzap/protocol/socket";
import type { AppId, AppManifest } from "@moltzap/protocol/identity";
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
// supplies name / conversations / hooks. Both policies take their open
// static verdict in-process, so no callback fires during these scenarios.
const APP_MANIFEST: AppManifest = {
  name: "App Session Scoping Test App",
  appId: "00000000-0000-4000-8000-000000010004",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
  hooks: {
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "forwardAllExceptSender" },
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
 * Register an app (HTTP), open its `AppConnection`, and return the live app
 * client plus the DB-minted appId.
 * @param name Manifest display name, distinct per registered app.
 * @returns The setup app result.
 */
function setupApp(
  name: string,
): Effect.Effect<{ appClient: TestAppClient; appId: AppId }, unknown> {
  return Effect.gen(function* () {
    const registered = yield* registerApp(getBaseUrl(), {
      ...APP_MANIFEST,
      name,
    });
    const appClient = yield* connectAppClient(
      registered.appId,
      registered.appKey,
      staticVerdictHandlers(),
    );
    return { appClient, appId: registered.appId };
  });
}

function staticVerdictHandlers(): AppCallbackHandlers<AppCallbackContext> {
  return {
    [dispatchAuthorize.name]: {
      definition: dispatchAuthorize,
      handle: () => Effect.dieMessage("unexpected app/dispatch/authorize"),
    },
    [messagesAuthorize.name]: {
      definition: messagesAuthorize,
      handle: () => Effect.dieMessage("unexpected app/message/authorize"),
    },
  };
}

function owningAppConnPassesOwnershipGate() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice");
    const bob = yield* registerAndConnect("bob");
    const { appClient } = yield* setupApp("Owning App");
    const conv = yield* appClient.sendRpc(conversationCreate, {
      participants: [alice.agentId],
    });
    yield* appClient.sendRpc(conversationUpdate, {
      action: "add-participant",
      conversationId: conv.conversation.id,
      agentId: bob.agentId,
    });
    expect(conv.conversation.id).toBeTruthy();
  });
}

function nonOwningAppFailsAppOwnershipGate() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-3");
    const bob = yield* registerAndConnect("bob-3");
    const { appClient } = yield* setupApp("Owning App 3");
    const conv = yield* appClient.sendRpc(conversationCreate, {
      participants: [alice.agentId],
    });
    // A DIFFERENT app (fresh appKey → different DB appId) does not own the
    // conversation; `assertCallerAppOwnsConversation` rejects it.
    const other = yield* setupApp("Other App");
    const exit = yield* Effect.exit(
      other.appClient.sendRpc(conversationUpdate, {
        action: "add-participant",
        conversationId: conv.conversation.id,
        agentId: bob.agentId,
      }),
    );
    expect(rpcErrorCode(exit)).toBe(WIRE_ERROR_TAG.Forbidden);
  });
}

describe("app-session-scoping — app authority via owning app principal", () => {
  it(
    "the owning app connection passes the app ownership gate",
    owningAppConnPassesOwnershipGate,
    20_000,
  );
  it(
    "a non-owning app fails the app ownership gate",
    nonOwningAppFailsAppOwnershipGate,
    20_000,
  );
});
