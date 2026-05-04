import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Exit, Ref, HashMap } from "effect";
import type {
  BeforeDispatchContext,
  BeforeMessageDeliveryContext,
  OnSessionActiveContext,
  OnCloseContext,
  DispatchAdmissionResult,
  HookResult,
} from "@moltzap/protocol";

// Phase 1.4 / B.5 handler-surface tests.
//
// We mock `@moltzap/client` to expose `handleServerRpc` (the real client
// keeps an internal `Ref<HashMap<method, handler>>`; we mirror that shape
// using Effect's own `Ref` so the duplicate-registration test goes through
// the same code path as production).  Each test drives an inbound app-callback
// admission request directly into the registered handler and asserts on
// the outbound reply shape.
//
// `RpcServerError` is re-exported from the mock so the SDK's
// `mapAttachError` `instanceof` check resolves correctly.

// `vi.mock` is hoisted to the top of the file; classes referenced inside
// the factory must be declared via `vi.hoisted` so they exist at hoist
// time. See https://vitest.dev/api/vi.html#vi-hoisted.
const { MockRpcServerError, MockDuplicateError } = vi.hoisted(() => {
  class MockRpcServerError extends Error {
    readonly _tag = "RpcServerError";
    readonly code: number;
    readonly data?: unknown;
    constructor(args: { code: number; message: string; data?: unknown }) {
      super(args.message);
      this.code = args.code;
      this.data = args.data;
    }
  }
  class MockDuplicateError extends Error {
    readonly _tag = "DuplicateServerRpcHandlerError";
    constructor(public readonly method: string) {
      super(`duplicate handler: ${method}`);
    }
  }
  return { MockRpcServerError, MockDuplicateError };
});

type MockRpcServerErrorInstance = InstanceType<typeof MockRpcServerError>;

interface InstalledHandler {
  (params: unknown): Effect.Effect<unknown, MockRpcServerErrorInstance>;
}

// Override `RpcServerError` so `mapAttachError`'s `instanceof` check
// matches the failures the mock client raises.
vi.mock("@moltzap/protocol", async () => {
  const actual =
    await vi.importActual<typeof import("@moltzap/protocol")>(
      "@moltzap/protocol",
    );
  return { ...actual, RpcServerError: MockRpcServerError };
});

vi.mock("@moltzap/client", async () => {
  return {
    MoltZapWsClient: vi.fn().mockImplementation(() => {
      const handlers = Effect.runSync(
        Ref.make<HashMap.HashMap<string, InstalledHandler>>(HashMap.empty()),
      );
      let attachShouldFail: {
        error: MockRpcServerErrorInstance | Error;
        isRpc: boolean;
      } | null = null;

      return {
        // Capture-everything subscribe so app.start() succeeds if a test
        // wires it up.  Most handler-surface tests skip start() entirely.
        subscribe: vi.fn().mockImplementation(() =>
          Effect.succeed({
            id: "sub-mock",
            unsubscribe: Effect.succeed(undefined),
          }),
        ),
        connect: vi
          .fn()
          .mockImplementation(() => Effect.succeed({ agentId: "agent-1" })),
        sendRpc: vi.fn().mockImplementation((definition: { name: string }) => {
          const method = definition.name;
          if (method === AppsAttachConversation.name) {
            if (attachShouldFail !== null) {
              const err = attachShouldFail.error;
              attachShouldFail = null;
              return Effect.fail(err);
            }
            return Effect.succeed({});
          }
          return Effect.succeed({});
        }),
        close: vi.fn().mockImplementation(() => Effect.succeed(undefined)),
        disconnect: vi.fn().mockImplementation(() => Effect.succeed(undefined)),
        handleServerRpc: vi
          .fn()
          .mockImplementation(
            (definition: { name: string }, handler: InstalledHandler) =>
              Effect.gen(function* () {
                const method = definition.name;
                const swapped = yield* Ref.modify(handlers, (m) => {
                  if (HashMap.has(m, method)) return [false, m];
                  return [true, HashMap.set(m, method, handler)];
                });
                if (!swapped) {
                  return yield* Effect.fail(new MockDuplicateError(method));
                }
              }),
          ),
        // Test helpers exposed via underscore prefix.
        _invokeHandler(
          method: string,
          params: unknown,
        ): Effect.Effect<unknown, MockRpcServerErrorInstance> {
          const m = Effect.runSync(Ref.get(handlers));
          const h = HashMap.get(m, method);
          if (h._tag === "None") {
            throw new Error(`no handler for ${method}`);
          }
          return h.value(params);
        },
        _hasHandler(method: string): boolean {
          const m = Effect.runSync(Ref.get(handlers));
          return HashMap.has(m, method);
        },
        _setAttachFailure(err: MockRpcServerErrorInstance | Error): void {
          attachShouldFail = {
            error: err,
            isRpc: err instanceof MockRpcServerError,
          };
        },
      };
    }),
    DuplicateServerRpcHandlerError: MockDuplicateError,
  };
});

// Import the SDK AFTER vi.mock so the mock is active.
import { MoltZapApp } from "./app.js";
import {
  AppHandlerError,
  AttachAlreadyAttachedError,
  AttachConversationNotFoundError,
  AttachFailedError,
  AttachNotAuthorizedError,
  AttachSessionNotFoundError,
  DuplicateHookHandlerError,
} from "./errors.js";
import {
  AppsAttachConversation,
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnClose,
  AppsOnSessionActive,
  agentId,
  conversationId,
  messageId,
} from "@moltzap/protocol";

interface MockedWsClient {
  _invokeHandler: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, MockRpcServerErrorInstance>;
  _hasHandler: (method: string) => boolean;
  _setAttachFailure: (err: MockRpcServerErrorInstance | Error) => void;
}

const asMock = (c: unknown): MockedWsClient => c as MockedWsClient;

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = conversationId("22222222-2222-4222-8222-222222222222");
const RECIPIENT_AGENT_ID = agentId("33333333-3333-4333-8333-333333333333");
const SENDER_AGENT_ID = agentId("44444444-4444-4444-8444-444444444444");
const LIFECYCLE_AGENT_ID = agentId("55555555-5555-4555-8555-555555555555");
const MESSAGE_ID = messageId("66666666-6666-4666-8666-666666666666");

const baseDispatchCtx: BeforeDispatchContext = {
  sessionId: SESSION_ID,
  appId: "test-app",
  conversationId: CONVERSATION_ID,
  recipient: { agentId: RECIPIENT_AGENT_ID, ownerId: "owner-r" },
  message: { id: MESSAGE_ID, senderAgentId: SENDER_AGENT_ID },
  attempt: 0,
};

const baseDeliveryCtx: BeforeMessageDeliveryContext = {
  sessionId: SESSION_ID,
  appId: "test-app",
  conversationId: CONVERSATION_ID,
  sender: { agentId: SENDER_AGENT_ID, ownerId: "owner-s" },
  message: { parts: [{ type: "text", text: "hi" }] },
};

const baseSessionActiveCtx: OnSessionActiveContext = {
  sessionId: SESSION_ID,
  appId: "test-app",
  conversations: { default: CONVERSATION_ID },
  admittedAgentIds: [LIFECYCLE_AGENT_ID],
};

const baseCloseCtx: OnCloseContext = {
  sessionId: SESSION_ID,
  appId: "test-app",
  conversations: { default: CONVERSATION_ID },
  closedBy: { agentId: LIFECYCLE_AGENT_ID, ownerId: "owner-1" },
};

describe("MoltZapApp — admission/lifecycle handler surface", () => {
  let app: MoltZapApp;
  let onErr: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new MoltZapApp({
      serverUrl: "ws://localhost:3000",
      agentKey: "test-key",
      appId: "test-app",
    });
    onErr = vi.fn();
    app.onError(onErr);
  });

  describe("onBeforeDispatch", () => {
    it("registers a handler that wraps the verdict in { admission }", async () => {
      app.onBeforeDispatch((ctx) =>
        Effect.succeed<DispatchAdmissionResult>({
          decision: "grant",
          leaseId: `lease-${ctx.sessionId.slice(0, 4)}`,
        }),
      );
      expect(asMock(app.client)._hasHandler(AppsOnBeforeDispatch.name)).toBe(
        true,
      );

      const reply = await Effect.runPromise(
        asMock(app.client)._invokeHandler(
          AppsOnBeforeDispatch.name,
          baseDispatchCtx,
        ),
      );
      expect(reply).toEqual({
        admission: { decision: "grant", leaseId: "lease-1111" },
      });
    });

    it("does not impose its own timeout on a long-running handler (AppHost owns timeout)", async () => {
      // Architect plan §3.4: "Timeout policy moves into AppHost, not the
      // schema."  The SDK must not abort or shorten a user handler — the
      // server-side AppHost wraps the app-callback RPC in
      // `Effect.timeout(manifestMs)`.
      // This test pins the contract: while the WS is healthy, a slow handler
      // returns its verdict verbatim, no SDK-side cancellation.
      app.onBeforeDispatch((ctx) =>
        Effect.sleep("50 millis").pipe(
          Effect.as<DispatchAdmissionResult>({
            decision: "grant",
            leaseId: `slow-${ctx.sessionId.slice(0, 4)}`,
          }),
        ),
      );
      const start = Date.now();
      const reply = await Effect.runPromise(
        asMock(app.client)._invokeHandler(
          AppsOnBeforeDispatch.name,
          baseDispatchCtx,
        ),
      );
      const elapsed = Date.now() - start;
      expect(reply).toEqual({
        admission: { decision: "grant", leaseId: "slow-1111" },
      });
      // Lower bound: the handler actually waited.  Upper bound is loose
      // (CI variance) — the assertion is "at least the sleep ran", not
      // "exactly 50ms".
      expect(elapsed).toBeGreaterThanOrEqual(40);
      // No fail-closed verdict was synthesized → onError must not have fired.
      expect(onErr).not.toHaveBeenCalled();
    });

    it("synthesizes deny with reason 'app_handler_error' on handler defect", async () => {
      app.onBeforeDispatch(() =>
        Effect.sync<DispatchAdmissionResult>(() => {
          throw new Error("user code blew up");
        }),
      );
      const reply = await Effect.runPromise(
        asMock(app.client)._invokeHandler(
          AppsOnBeforeDispatch.name,
          baseDispatchCtx,
        ),
      );
      expect(reply).toEqual({
        admission: { decision: "deny", reason: "app_handler_error" },
      });
      expect(onErr).toHaveBeenCalledTimes(1);
      const errArg = onErr.mock.calls[0]![0] as AppHandlerError;
      expect(errArg).toBeInstanceOf(AppHandlerError);
      expect(errArg.method).toBe(AppsOnBeforeDispatch.name);
    });

    it("throws DuplicateHookHandlerError on second registration", () => {
      app.onBeforeDispatch(() =>
        Effect.succeed<DispatchAdmissionResult>({ decision: "grant" }),
      );
      expect(() =>
        app.onBeforeDispatch(() =>
          Effect.succeed<DispatchAdmissionResult>({ decision: "grant" }),
        ),
      ).toThrow(DuplicateHookHandlerError);
      try {
        app.onBeforeDispatch(() =>
          Effect.succeed<DispatchAdmissionResult>({ decision: "grant" }),
        );
      } catch (e) {
        expect(e).toBeInstanceOf(DuplicateHookHandlerError);
      }
    });
  });

  describe("onBeforeMessageDelivery", () => {
    it("returns the user verdict verbatim on success", async () => {
      const verdict: HookResult = {
        block: false,
        patch: { parts: [{ type: "text", text: "patched" }] },
      };
      app.onBeforeMessageDelivery(() => Effect.succeed(verdict));
      const reply = await Effect.runPromise(
        asMock(app.client)._invokeHandler(
          AppsOnBeforeMessageDelivery.name,
          baseDeliveryCtx,
        ),
      );
      expect(reply).toEqual(verdict);
    });

    it("synthesizes block:true / reason:'app_handler_error' on defect", async () => {
      app.onBeforeMessageDelivery(() =>
        Effect.sync<HookResult>(() => {
          throw new Error("kaboom");
        }),
      );
      const reply = await Effect.runPromise(
        asMock(app.client)._invokeHandler(
          AppsOnBeforeMessageDelivery.name,
          baseDeliveryCtx,
        ),
      );
      expect(reply).toEqual({ block: true, reason: "app_handler_error" });
      expect(onErr).toHaveBeenCalledTimes(1);
    });
  });

  describe("lifecycle hooks (onSessionActive / onClose)", () => {
    it.each([
      [AppsOnSessionActive.name, baseSessionActiveCtx, "onSessionActive"],
      [AppsOnClose.name, baseCloseCtx, "onClose"],
    ] as const)(
      "%s replies with empty result on success",
      async (method, ctx, methodName) => {
        const seen = vi.fn();
        const register =
          methodName === "onSessionActive"
            ? app.onSessionActive.bind(app)
            : app.onClose.bind(app);
        register((c: unknown) =>
          Effect.sync(() => {
            seen(c);
          }),
        );
        const reply = await Effect.runPromise(
          asMock(app.client)._invokeHandler(method, ctx),
        );
        expect(reply).toEqual({});
        expect(seen).toHaveBeenCalledWith(ctx);
      },
    );

    it("logs + replies void when the lifecycle handler defects (fail-open)", async () => {
      app.onSessionActive(() =>
        Effect.sync(() => {
          throw new Error("kaboom");
        }),
      );
      const reply = await Effect.runPromise(
        asMock(app.client)._invokeHandler(
          AppsOnSessionActive.name,
          baseSessionActiveCtx,
        ),
      );
      expect(reply).toEqual({});
      expect(onErr).toHaveBeenCalledTimes(1);
      const errArg = onErr.mock.calls[0]![0] as AppHandlerError;
      expect(errArg.method).toBe(AppsOnSessionActive.name);
    });

    it("each lifecycle hook rejects duplicate registration", () => {
      app.onClose(() => Effect.void);
      expect(() => app.onClose(() => Effect.void)).toThrow(
        DuplicateHookHandlerError,
      );
    });
  });

  describe("attachConversation", () => {
    it("succeeds when the RPC succeeds", async () => {
      const result = await Effect.runPromise(
        app.attachConversation(SESSION_ID, CONVERSATION_ID),
      );
      expect(result).toBeUndefined();
    });

    it.each([
      ["SessionNotFound", AttachSessionNotFoundError],
      ["ConversationNotFound", AttachConversationNotFoundError],
      ["NotAuthorized", AttachNotAuthorizedError],
      ["AlreadyAttached", AttachAlreadyAttachedError],
    ])(
      "maps RpcServerError data.code='%s' to %s",
      async (dataCode, ExpectedError) => {
        asMock(app.client)._setAttachFailure(
          new MockRpcServerError({
            code: -32099,
            message: "rejected",
            data: { code: dataCode },
          }),
        );
        const exit = await Effect.runPromiseExit(
          app.attachConversation(SESSION_ID, CONVERSATION_ID),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
          expect(err).toBeInstanceOf(ExpectedError);
        }
      },
    );

    // Substring-fallback path: when the server emits a text-only RPC error
    // (no numeric -32003, no structured `data.code`), the SDK matches the
    // canonical server message — see
    // `packages/server/src/app/app-host.ts` ("Conversation X is already
    // attached to session Y") — and routes to AttachAlreadyAttachedError.
    it("maps 'already attached' message substring to AttachAlreadyAttachedError", async () => {
      asMock(app.client)._setAttachFailure(
        new MockRpcServerError({
          code: -32099,
          message:
            "Conversation conv-2 is already attached to session 00000000-0000-0000-0000-000000000099",
        }),
      );
      const exit = await Effect.runPromiseExit(
        app.attachConversation(SESSION_ID, CONVERSATION_ID),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
        expect(err).toBeInstanceOf(AttachAlreadyAttachedError);
      }
    });

    it("falls back to AttachFailed for unknown RPC errors", async () => {
      asMock(app.client)._setAttachFailure(
        new MockRpcServerError({ code: -32099, message: "boom" }),
      );
      const exit = await Effect.runPromiseExit(
        app.attachConversation(SESSION_ID, CONVERSATION_ID),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
        expect(err).toBeInstanceOf(AttachFailedError);
      }
    });

    // Numeric-code path: `extractAttachCode` consults the wire-level
    // `err.code` first (NumericCodeToAttach), falling back to structured
    // `data.code` only on miss. Mirrors the integration test in
    // `30-app-hooks-rpc.integration.test.ts` ("Conflict (-32003) →
    // AttachAlreadyAttachedError"). Keeps the SDK-side numeric map
    // honest without booting the real server.
    it.each([
      [-32021, AttachSessionNotFoundError],
      [-32002, AttachConversationNotFoundError],
      [-32001, AttachNotAuthorizedError],
      [-32003, AttachAlreadyAttachedError],
    ])(
      "maps numeric err.code=%s to %s via NumericCodeToAttach",
      async (numericCode, ExpectedError) => {
        asMock(app.client)._setAttachFailure(
          new MockRpcServerError({ code: numericCode, message: "rejected" }),
        );
        const exit = await Effect.runPromiseExit(
          app.attachConversation(SESSION_ID, CONVERSATION_ID),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
          expect(err).toBeInstanceOf(ExpectedError);
        }
      },
    );
  });

  describe("type-narrowed handler signatures (compile-time)", () => {
    // These tests are partly compile-time assertions; the bodies just
    // ensure runtime registration succeeds.  If the type imports drift,
    // tsc fails before vitest runs.
    it("BeforeDispatchContext narrows correctly", () => {
      const handler = (
        ctx: BeforeDispatchContext,
      ): Effect.Effect<DispatchAdmissionResult, never> =>
        Effect.succeed({
          decision: "grant" as const,
          leaseId: ctx.message.id,
        });
      app.onBeforeDispatch(handler);
      expect(asMock(app.client)._hasHandler(AppsOnBeforeDispatch.name)).toBe(
        true,
      );
    });

    it("HookResult narrows correctly for delivery handler", () => {
      const handler = (
        _ctx: BeforeMessageDeliveryContext,
      ): Effect.Effect<HookResult, never> => Effect.succeed({ block: false });
      app.onBeforeMessageDelivery(handler);
      expect(
        asMock(app.client)._hasHandler(AppsOnBeforeMessageDelivery.name),
      ).toBe(true);
    });

    it("OnSessionActiveContext narrows correctly", () => {
      const handler = (
        ctx: OnSessionActiveContext,
      ): Effect.Effect<void, never> => Effect.sync(() => ctx.sessionId);
      app.onSessionActive(handler);
      expect(asMock(app.client)._hasHandler(AppsOnSessionActive.name)).toBe(
        true,
      );
    });
  });
});
