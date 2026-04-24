/**
 * Unit tests for the transport layer — pure decision table + composition-
 * boundary checks. Integration coverage of the direct-WS branch lives in
 * the E2E fixture (`__tests__/cli-multi-agent.int.test.ts`).
 */
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideTransport,
  resolveTransportInputs,
  tagWsError,
  TransportDecodeError,
  TransportRpcError,
  ServiceUnreachableError,
  TransportTimeoutError,
  type TransportOptions,
} from "./transport.js";

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
 * Regression guard for sbd#198: `Effect.runPromise` wrapping of `sendRpc`
 * produced `FiberFailureImpl` (with `_tag = undefined`), causing `tagWsError`'s
 * default branch to emit `TransportDecodeError` for every ws error. `tagWsError`
 * is `@internal`-exported so this suite can reach it without a mock WS server.
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

  it("default branch (unknown _tag) maps to TransportDecodeError", () => {
    const err = tagWsError("apps/listSessions", {
      _tag: "SomeUnknownError",
    });
    expect(err).toBeInstanceOf(TransportDecodeError);
  });

  it("FiberFailureImpl-shaped error (no _tag) maps to TransportDecodeError — not to TransportRpcError", () => {
    // Simulates FiberFailureImpl (_tag absent): pre-fix behaviour hit the
    // default branch and emitted TransportDecodeError for every server error.
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
