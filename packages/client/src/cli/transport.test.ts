/**
 * Unit tests for the transport layer — pure decision table + composition-
 * boundary checks. Integration coverage of the direct-WS branch lives in
 * the E2E fixture (`__tests__/cli-multi-agent.int.test.ts`).
 */
import { Cause, Effect, Exit, Option } from "effect";
import * as fc from "fast-check";
import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  NotConnectedError,
  NotFoundError,
  RpcTimeoutError,
} from "@moltzap/protocol";
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

import { TaskList, TaskRejectedError } from "@moltzap/protocol";

const it = effectIt.effect;
const SESSION_NOT_FOUND_CODE = -32001;
const RPC_TIMEOUT_MS = 15_000;
const SERVER_URL = "wss://example.test";
const TEST_SOCKET_PATH = "/var/run/moltzap-test.sock";
const USE_DIRECT_TAG = "UseDirect";
const USE_DAEMON_TAG = "UseDaemon";
const AS_FLAG_REASON = "as-flag";
const PROFILE_REASON = "profile";
const ENV_FALLBACK_REASON = "env-fallback";
const TRANSPORT_RPC_ERROR_TAG = "TransportRpcError";
const SERVICE_UNREACHABLE_ERROR_TAG = "ServiceUnreachableError";
const TRANSPORT_DECODE_ERROR_TAG = "TransportDecodeError";
const SESSION_NOT_FOUND_MESSAGE = "session not found";
const ITEM_NOT_FOUND_MESSAGE = "item not found";
const NOT_CONNECTED_MESSAGE = "not connected";
const UNKNOWN_ERROR_MESSAGE = "some unknown error";
const IMPERSONATE_KEY = "key-1";
const PROFILE_KEY = "pk-1";
const ENV_KEY = "env-key";
const LEAKED_ENV_KEY = "leaked-key";
const EXPLICIT_KEY = "explicit-key";
const OVERRIDE_SERVER_URL = "wss://override.test";
const DIRECT_TEST_KEY = "test-key";
const DIRECT_TEST_SERVER_URL = "wss://test.example";

function makeMockWsClient() {
  return {
    connect: () => Effect.void,
    call: () =>
      Effect.fail(
        new NotFoundError({
          message: ITEM_NOT_FOUND_MESSAGE,
        }),
      ),
    close: () => Effect.void,
  };
}

/**
 * Module-level mock so transport.ts's `new MoltZapAgentClient(...)` call is
 * intercepted for the composed-rpc test below. Existing tests (decideTransport,
 * tagWsError, resolveTransportInputs) do not exercise the ws-client path, so
 * the mock is a no-op for them.
 */
vi.mock("../agent-client.js", () => ({
  MoltZapAgentClient: vi.fn().mockImplementation(makeMockWsClient),
}));

const makeOpts = (over: Partial<TransportOptions> = {}): TransportOptions => ({
  serverUrl: SERVER_URL,
  ...over,
});

const unreachableDaemon = () => Effect.succeed(false);
const reachableDaemon = () => Effect.succeed(true);

function countedProbe(counter: { count: number }) {
  return () =>
    Effect.sync(() => {
      counter.count++;
      return true;
    });
}

function useDirectAsFlag() {
  return Effect.gen(function* () {
    const probe = { count: 0 };
    const decision = yield* decideTransport(
      makeOpts({
        impersonateKey: IMPERSONATE_KEY,
        probeDaemon: countedProbe(probe),
      }),
    );
    expect(decision).toEqual({ _tag: USE_DIRECT_TAG, reason: AS_FLAG_REASON });
    expect(probe.count).toBe(0);
  });
}

function useDirectProfile() {
  return Effect.gen(function* () {
    const decision = yield* decideTransport(
      makeOpts({ profileKey: PROFILE_KEY }),
    );
    expect(decision).toEqual({ _tag: USE_DIRECT_TAG, reason: PROFILE_REASON });
  });
}

function useDirectEnvFallback() {
  return Effect.gen(function* () {
    const decision = yield* decideTransport(
      makeOpts({ envFallbackKey: ENV_KEY, probeDaemon: unreachableDaemon }),
    );
    expect(decision).toEqual({
      _tag: USE_DIRECT_TAG,
      reason: ENV_FALLBACK_REASON,
    });
  });
}

function useDaemonWhenReachable() {
  return Effect.gen(function* () {
    const decision = yield* decideTransport(
      makeOpts({
        envFallbackKey: ENV_KEY,
        socketPath: TEST_SOCKET_PATH,
        probeDaemon: reachableDaemon,
      }),
    );
    expect(decision._tag).toBe(USE_DAEMON_TAG);
  });
}

function useDaemonByDefault() {
  return Effect.gen(function* () {
    const decision = yield* decideTransport(
      makeOpts({ socketPath: TEST_SOCKET_PATH }),
    );
    expect(decision).toEqual({
      _tag: USE_DAEMON_TAG,
      socketPath: TEST_SOCKET_PATH,
    });
  });
}

function impersonateBypassesProbe() {
  return Effect.gen(function* () {
    const probe = { count: 0 };
    yield* decideTransport(
      makeOpts({
        impersonateKey: IMPERSONATE_KEY,
        probeDaemon: countedProbe(probe),
      }),
    );
    expect(probe.count).toBe(0);
  });
}

function expectBypassForKey(key: string): void {
  const probe = { count: 0 };
  const decision = Effect.runSync(
    decideTransport(
      makeOpts({
        impersonateKey: key,
        probeDaemon: countedProbe(probe),
      }),
    ),
  );
  expect(decision._tag).toBe(USE_DIRECT_TAG);
  expect(probe.count).toBe(0);
}

function impersonateBypassesProbeForAnyKey() {
  return Effect.sync(() => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), expectBypassForKey));
  });
}

describe("decideTransport", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "impersonate key bypasses daemon probe for any non-empty key",
    impersonateBypassesProbeForAnyKey,
  );

  it("returns UseDirect{as-flag} when impersonateKey is set", useDirectAsFlag);

  it(
    "returns UseDirect{profile} when profileKey set and no --as",
    useDirectProfile,
  );

  it(
    "returns UseDirect{env-fallback} when envFallbackKey + daemonReachable=false",
    useDirectEnvFallback,
  );

  it(
    "returns UseDaemon when envFallbackKey + daemonReachable=true",
    useDaemonWhenReachable,
  );

  it(
    "returns UseDaemon when neither as-flag nor env-fallback nor profile",
    useDaemonByDefault,
  );

  it(
    "never invokes probeDaemon when impersonateKey is set (Invariant §4.2)",
    impersonateBypassesProbe,
  );
});

function expectTimeoutForwarded(timeoutMs: number): void {
  const err = tagWsError(
    TaskList.name,
    new RpcTimeoutError({ method: TaskList.name, timeoutMs }),
  );
  expect(err).toBeInstanceOf(TransportTimeoutError);
  if (err instanceof TransportTimeoutError) {
    expect(err.timeoutMs).toBe(timeoutMs);
  }
}

function timeoutErrorForwardsGeneratedTimeouts() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60_000 }), expectTimeoutForwarded),
    );
  });
}

function rpcServerErrorMapsToTransportRpcError() {
  return Effect.sync(() => {
    const err = tagWsError(
      TaskList.name,
      new NotFoundError({
        message: SESSION_NOT_FOUND_MESSAGE,
      }),
    );
    expect(err).toBeInstanceOf(TransportRpcError);
    expect(err._tag).toBe(TRANSPORT_RPC_ERROR_TAG);
    if (err instanceof TransportRpcError) {
      expect(err.tag).toBe("NotFound");
      expect(err.message).toBe(SESSION_NOT_FOUND_MESSAGE);
    }
  });
}

function registeredWireErrorMapsToTransportRpcError() {
  return Effect.sync(() => {
    // A registered domain wire error (decoded from a -32024 frame) carries its
    // numeric code on the constructor, not the instance. It must map to
    // TransportRpcError preserving code/reason — not fall through to decode.
    const err = tagWsError(
      TaskList.name,
      new TaskRejectedError({
        message: TaskRejectedError.message,
        data: { taskId: "task-1" },
      }),
    );
    expect(err).toBeInstanceOf(TransportRpcError);
    expect(err._tag).toBe(TRANSPORT_RPC_ERROR_TAG);
    if (err instanceof TransportRpcError) {
      expect(err.tag).toBe("TaskRejected");
      expect(err.message).toBe(TaskRejectedError.message);
      expect(err.data).toEqual({ taskId: "task-1" });
    }
  });
}

function notConnectedMapsToServiceUnreachable() {
  return Effect.sync(() => {
    const err = tagWsError(
      TaskList.name,
      new NotConnectedError({ message: NOT_CONNECTED_MESSAGE }),
    );
    expect(err).toBeInstanceOf(ServiceUnreachableError);
    expect(err._tag).toBe(SERVICE_UNREACHABLE_ERROR_TAG);
  });
}

function rpcTimeoutMapsToTransportTimeout() {
  return Effect.sync(() => {
    const err = tagWsError(
      TaskList.name,
      new RpcTimeoutError({
        method: TaskList.name,
        timeoutMs: RPC_TIMEOUT_MS,
      }),
    );
    expect(err).toBeInstanceOf(TransportTimeoutError);
    if (err instanceof TransportTimeoutError) {
      expect(err.timeoutMs).toBe(RPC_TIMEOUT_MS);
    }
  });
}

function unknownErrorMapsToTransportDecode() {
  return Effect.sync(() => {
    const err = tagWsError(TaskList.name, {
      message: UNKNOWN_ERROR_MESSAGE,
    });
    expect(err).toBeInstanceOf(TransportDecodeError);
    expect(err._tag).toBe(TRANSPORT_DECODE_ERROR_TAG);
  });
}

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
  it(
    "RpcTimeoutError forwards generated timeoutMs values",
    timeoutErrorForwardsGeneratedTimeouts,
  );

  it(
    "RpcServerError maps to TransportRpcError (not TransportDecodeError)",
    rpcServerErrorMapsToTransportRpcError,
  );

  it(
    "registered wire error (TaskRejected) maps to TransportRpcError with its static code",
    registeredWireErrorMapsToTransportRpcError,
  );

  it(
    "NotConnectedError maps to ServiceUnreachableError",
    notConnectedMapsToServiceUnreachable,
  );

  it(
    "RpcTimeoutError maps to TransportTimeoutError with timeoutMs forwarded",
    rpcTimeoutMapsToTransportTimeout,
  );

  it(
    "FiberFailureImpl-shaped error (no _tag) maps to TransportDecodeError — not to TransportRpcError",
    unknownErrorMapsToTransportDecode,
  );
});

function explicitKeyIgnoresEnvKey() {
  return Effect.gen(function* () {
    vi.stubEnv("MOLTZAP_API_KEY", LEAKED_ENV_KEY);
    const opts = yield* resolveTransportInputs({
      impersonateKey: EXPLICIT_KEY,
    });
    expect(opts.impersonateKey).toBe(EXPLICIT_KEY);
    expect(opts.profileKey).toBeUndefined();
  });
}

function explicitKeyUsesServerUrlEnv() {
  return Effect.gen(function* () {
    vi.stubEnv("MOLTZAP_SERVER_URL", OVERRIDE_SERVER_URL);
    const opts = yield* resolveTransportInputs({ impersonateKey: "k" });
    expect(opts.serverUrl).toBe(OVERRIDE_SERVER_URL);
  });
}

function emptyInputUsesDaemon() {
  return Effect.gen(function* () {
    const opts = yield* resolveTransportInputs({});
    expect(opts.impersonateKey).toBeUndefined();
    expect(opts.profileKey).toBeUndefined();
    expect(opts.socketPath).toBeDefined();
  });
}

function directRpcFailurePropagates() {
  return Effect.gen(function* () {
    const opts: TransportOptions = {
      impersonateKey: DIRECT_TEST_KEY,
      serverUrl: DIRECT_TEST_SERVER_URL,
    };
    const exit = yield* Transport.pipe(
      Effect.flatMap((transport) => transport.rpc(TaskList.name, {})),
      Effect.exit,
      Effect.provide(makeTransportLayer(opts)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(TransportRpcError);
        expect(failure.value._tag).toBe(TRANSPORT_RPC_ERROR_TAG);
      }
    }
  });
}

describe("resolveTransportInputs (composition-boundary gate)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "impersonateKey branch does NOT read MOLTZAP_API_KEY env",
    explicitKeyIgnoresEnvKey,
  );

  it(
    "impersonateKey branch uses MOLTZAP_SERVER_URL if present, else default",
    explicitKeyUsesServerUrlEnv,
  );

  it(
    "empty input falls through to legacy daemon path (no impersonate, no profile)",
    emptyInputUsesDaemon,
  );
});

/**
 * Composed rpc() failure path — pins the full call chain so a future
 * regression to `Effect.runPromise(sendRpc)` inside `Effect.tryPromise`
 * is caught here, not just in the isolated `tagWsError` suite above.
 *
 * The ws-client mock (module-level `vi.mock("../agent-client.js")`) makes
 * `sendRpc` return `Effect.fail(new RpcServerError(...))` so the test
 * exercises: connect (success) → sendRpc (RpcServerError) → tagWsError
 * → TransportRpcError. A runPromise bridge would wrap RpcServerError in
 * FiberFailureImpl (no _tag) and the result would be TransportDecodeError.
 */
describe("makeDirectTransport — composed rpc() failure path", () => {
  it(
    "RpcServerError from sendRpc propagates as TransportRpcError through tagWsError",
    directRpcFailurePropagates,
  );
});
