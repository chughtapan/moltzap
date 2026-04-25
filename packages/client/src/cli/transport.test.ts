/**
 * Unit tests for the transport layer — pure decision table + composition-
 * boundary checks. Integration coverage of the direct-WS branch lives in
 * the E2E fixture (`__tests__/cli-multi-agent.int.test.ts`).
 */
import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideTransport,
  makeTransportLayer,
  resolveTransportInputs,
  tagWsError,
  Transport,
  TransportDecodeError,
  TransportRpcError,
  ServiceUnreachableError,
  TransportTimeoutError,
  type TransportOptions,
} from "./transport.js";

/**
 * Module-level mock so transport.ts's `new MoltZapWsClient(...)` call is
 * intercepted for the composed-rpc test below. Existing tests (decideTransport,
 * tagWsError, resolveTransportInputs) do not exercise the ws-client path, so
 * the mock is a no-op for them.
 */
vi.mock("../ws-client.js", async () => {
  const effect = await import("effect");
  const errors = await import("../runtime/errors.js");
  return {
    MoltZapWsClient: vi.fn().mockImplementation(() => ({
      connect: () => effect.Effect.void,
      sendRpc: (_method: string, _params: unknown) =>
        effect.Effect.fail(
          new errors.RpcServerError({
            code: -32001,
            message: "item not found",
          }),
        ),
      close: () => effect.Effect.void,
    })),
  };
});

const makeOpts = (over: Partial<TransportOptions> = {}): TransportOptions => ({
  serverUrl: "wss://example.test",
  ...over,
});

describe("decideTransport", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MOLTZAP_API_KEY;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns UseDirect{as-flag} when impersonateKey is set", async () => {
    const probe = { invoked: 0 };
    const decision = await Effect.runPromise(
      decideTransport(
        makeOpts({
          impersonateKey: "key-1",
          probeDaemon: () =>
            Effect.sync(() => {
              probe.invoked++;
              return true;
            }),
        }),
      ),
    );
    expect(decision).toEqual({ _tag: "UseDirect", reason: "as-flag" });
    expect(probe.invoked).toBe(0);
  });

  it("returns UseDirect{profile} when profileKey set and no --as", async () => {
    const decision = await Effect.runPromise(
      decideTransport(makeOpts({ profileKey: "pk-1" })),
    );
    expect(decision).toEqual({ _tag: "UseDirect", reason: "profile" });
  });

  it("returns UseDirect{env-fallback} when MOLTZAP_API_KEY env + daemonReachable=false", async () => {
    process.env.MOLTZAP_API_KEY = "env-key";
    const decision = await Effect.runPromise(
      decideTransport(makeOpts({ probeDaemon: () => Effect.succeed(false) })),
    );
    expect(decision).toEqual({ _tag: "UseDirect", reason: "env-fallback" });
  });

  it("returns UseDaemon when MOLTZAP_API_KEY env + daemonReachable=true", async () => {
    process.env.MOLTZAP_API_KEY = "env-key";
    const decision = await Effect.runPromise(
      decideTransport(
        makeOpts({
          socketPath: "/tmp/sock",
          probeDaemon: () => Effect.succeed(true),
        }),
      ),
    );
    expect(decision._tag).toBe("UseDaemon");
  });

  it("returns UseDaemon when neither as-flag nor env-fallback nor profile", async () => {
    const decision = await Effect.runPromise(
      decideTransport(makeOpts({ socketPath: "/tmp/sock" })),
    );
    expect(decision).toEqual({ _tag: "UseDaemon", socketPath: "/tmp/sock" });
  });

  it("never invokes probeDaemon when impersonateKey is set (Invariant §4.2)", async () => {
    let invocations = 0;
    await Effect.runPromise(
      decideTransport(
        makeOpts({
          impersonateKey: "key-1",
          probeDaemon: () =>
            Effect.sync(() => {
              invocations++;
              return true;
            }),
        }),
      ),
    );
    expect(invocations).toBe(0);
  });
});

/**
 * Regression guard for sbd#198: the original v2 implementation at 069135d
 * used `Effect.runPromise(sendRpc)` inside `Effect.tryPromise`. In Effect 3.21,
 * `runPromise` wraps typed failures in `FiberFailureImpl` (no `_tag`), so
 * `tagWsError`'s switch hit the default branch and emitted `TransportDecodeError`
 * for every ws error. Fixed by code-guard commit ff2de0d; these tests guard
 * against regression to that pattern.
 *
 * `tagWsError` is `@internal`-exported so this suite can reach it directly
 * without a mock WS server.
 */
describe("tagWsError — maps ws-client error tags to TransportError variants", () => {
  it("RpcServerError maps to TransportRpcError (not TransportDecodeError)", () => {
    const err = tagWsError("apps/listSessions", {
      _tag: "RpcServerError",
      code: -32001,
      message: "session not found",
    });
    expect(err).toBeInstanceOf(TransportRpcError);
    expect(err._tag).toBe("TransportRpcError");
    if (err instanceof TransportRpcError) {
      expect(err.code).toBe(-32001);
      expect(err.message).toBe("session not found");
    }
  });

  it("NotConnectedError maps to ServiceUnreachableError", () => {
    const err = tagWsError("apps/listSessions", { _tag: "NotConnectedError" });
    expect(err).toBeInstanceOf(ServiceUnreachableError);
    expect(err._tag).toBe("ServiceUnreachableError");
  });

  it("RpcTimeoutError maps to TransportTimeoutError with timeoutMs forwarded", () => {
    const err = tagWsError("apps/listSessions", {
      _tag: "RpcTimeoutError",
      timeoutMs: 15_000,
    });
    expect(err).toBeInstanceOf(TransportTimeoutError);
    if (err instanceof TransportTimeoutError) {
      expect(err.timeoutMs).toBe(15_000);
    }
  });

  it("FiberFailureImpl-shaped error (no _tag) maps to TransportDecodeError — not to TransportRpcError", () => {
    // Guards the regression: a future runPromise bridge would produce an object
    // with no _tag (FiberFailureImpl shape). This pins the default branch to
    // TransportDecodeError so the error is observable, not silently swallowed.
    const err = tagWsError("apps/listSessions", {
      message: "some unknown error",
    });
    expect(err).toBeInstanceOf(TransportDecodeError);
    expect(err._tag).toBe("TransportDecodeError");
  });
});

describe("resolveTransportInputs (composition-boundary gate)", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MOLTZAP_API_KEY;
    delete process.env.MOLTZAP_SERVER_URL;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("impersonateKey branch does NOT read MOLTZAP_API_KEY env", async () => {
    process.env.MOLTZAP_API_KEY = "leaked-key";
    const opts = await Effect.runPromise(
      resolveTransportInputs({ impersonateKey: "explicit-key" }),
    );
    expect(opts.impersonateKey).toBe("explicit-key");
    // The returned TransportOptions does NOT expose MOLTZAP_API_KEY as profileKey.
    expect(opts.profileKey).toBeUndefined();
  });

  it("impersonateKey branch uses MOLTZAP_SERVER_URL if present, else default", async () => {
    process.env.MOLTZAP_SERVER_URL = "wss://override.test";
    const opts = await Effect.runPromise(
      resolveTransportInputs({ impersonateKey: "k" }),
    );
    expect(opts.serverUrl).toBe("wss://override.test");
  });

  it("empty input falls through to legacy daemon path (no impersonate, no profile)", async () => {
    const opts = await Effect.runPromise(resolveTransportInputs({}));
    expect(opts.impersonateKey).toBeUndefined();
    expect(opts.profileKey).toBeUndefined();
    expect(opts.socketPath).toBeDefined();
  });
});

/**
 * Composed rpc() failure path — pins the full call chain so a future
 * regression to `Effect.runPromise(sendRpc)` inside `Effect.tryPromise`
 * is caught here, not just in the isolated `tagWsError` suite above.
 *
 * The ws-client mock (module-level `vi.mock("../ws-client.js")`) makes
 * `sendRpc` return `Effect.fail(new RpcServerError(...))` so the test
 * exercises: connect (success) → sendRpc (RpcServerError) → tagWsError
 * → TransportRpcError. A runPromise bridge would wrap RpcServerError in
 * FiberFailureImpl (no _tag) and the result would be TransportDecodeError.
 */
describe("makeDirectTransport — composed rpc() failure path", () => {
  it("RpcServerError from sendRpc propagates as TransportRpcError through tagWsError", async () => {
    const opts: TransportOptions = {
      impersonateKey: "test-key",
      serverUrl: "wss://test.example",
    };
    const exit = await Effect.runPromise(
      Transport.pipe(
        Effect.flatMap((t) => t.rpc("apps/listSessions", {})),
        Effect.exit,
        Effect.provide(makeTransportLayer(opts)),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(TransportRpcError);
        expect(failure.value._tag).toBe("TransportRpcError");
      }
    }
  });
});
