import { assert, it as effectIt } from "@effect/vitest";
import {
  ExitCode as processExitCode,
  type ExitCode,
} from "@effect/platform/CommandExecutor";
import { AgentName } from "@moltzap/identity";
import { Deferred, Duration, Effect, Fiber, Redacted, Schema } from "effect";
import { describe } from "vitest";
import {
  acquireOpenClawGateway,
  GatewayOperations,
  OpenClawGatewayRequest,
  OpenClawGatewayRequestError,
  OpenClawGatewayStoppedBeforeHello,
  OpenClawGatewaySucceeded,
  OpenClawGatewayTimedOut,
  type OpenClawGatewayClient,
  type OpenClawGatewayClientFactory,
  type OpenClawGatewayResponse,
  type OpenClawGatewaySession,
} from "./gateway.js";

const test = effectIt.effect;
const GATEWAY_URL = "ws://127.0.0.1:43124";
const REMOTE_GATEWAY_URL = "ws://alice.society.svc:18789";
const GATEWAY_TOKEN = "test-openclaw-gateway-token";
const DEVICE_IDENTITY = Object.freeze({
  deviceId: "a".repeat(64),
  privateKeyPem: "private-key",
  publicKeyPem: "public-key",
});
const STARTUP_TIMEOUT = Duration.seconds(2);
const AGENT_METHOD = "agent";
const OPERATOR_ROLE = "operator";
const OPERATOR_WRITE_SCOPE = "operator.write";
const RUN_ID = "run-1";
const RESPONSE_TEXT = "done";
const INSTRUCTION = "Contact Bob over MoltZap.";
const IDEMPOTENCY_KEY = "instruction-1";
const AGENT_NAME = Schema.decodeUnknownSync(AgentName)("alice");
const PROVIDER_TIMEOUT_PHASE = "provider";
const GATEWAY_TEXT_MAX_LENGTH = 32 * 1_024;

interface ClientObservation {
  readonly method: string;
  readonly params: unknown;
  readonly options: Parameters<OpenClawGatewayClient["request"]>[2];
}

interface RoundTripFixture {
  readonly exitCode: Deferred.Deferred<ExitCode>;
  readonly requested: Deferred.Deferred<ClientObservation>;
  readonly stopped: Deferred.Deferred<undefined>;
  clientOptions?: Parameters<OpenClawGatewayClientFactory>[0];
}

function processSession(
  exitCode: Deferred.Deferred<ExitCode>,
): OpenClawGatewaySession {
  const observedExit = Deferred.await(exitCode);
  return {
    gatewayUrl: GATEWAY_URL,
    gatewayToken: Redacted.make(GATEWAY_TOKEN),
    deviceIdentity: DEVICE_IDENTITY,
    agentName: AGENT_NAME,
    stopped: observedExit.pipe(
      Effect.flatMap((code) =>
        Effect.fail(
          OpenClawGatewayStoppedBeforeHello.make({
            detail: `OpenClaw exited before its principal gateway exposed a hello response (exitCode=${String(code)})`,
          }),
        ),
      ),
    ),
  };
}

function notifyHello(
  options: Parameters<OpenClawGatewayClientFactory>[0],
): void {
  const notify =
    /* Safe because the production callback ignores HelloOk; this double reports only the handshake transition. */
    options.onHelloOk as (() => void) | undefined;
  notify?.();
}

function complete(deferred: Deferred.Deferred<undefined>): void {
  Effect.runSync(Deferred.succeed(deferred, undefined));
}

function roundTripClient(
  fixture: RoundTripFixture,
): OpenClawGatewayClientFactory {
  return (options) => {
    fixture.clientOptions = options;
    return {
      start: () => {
        notifyHello(options);
      },
      stop: () => {
        complete(fixture.stopped);
      },
      stopAndWait: () => {
        complete(fixture.stopped);
        return Promise.resolve();
      },
      request: (method, params, requestOptions) => {
        Effect.runSync(
          Deferred.succeed(fixture.requested, {
            method,
            params,
            options: requestOptions,
          }),
        );
        return Promise.resolve({
          runId: RUN_ID,
          status: "ok",
          summary: "completed",
          result: {
            payloads: [
              {
                text: RESPONSE_TEXT,
                isReasoning: false,
                channelData: { ignored: true },
              },
            ],
            meta: { ignored: true },
          },
          ignored: true,
        });
      },
    };
  };
}

function acquireGateway(
  session: OpenClawGatewaySession,
  makeClient: OpenClawGatewayClientFactory,
) {
  return acquireOpenClawGateway(session, STARTUP_TIMEOUT).pipe(
    Effect.provideService(GatewayOperations, makeClient),
  );
}

function runRoundTrip(fixture: RoundTripFixture) {
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* acquireGateway(
        processSession(fixture.exitCode),
        roundTripClient(fixture),
      );
      return yield* gateway.agent(
        OpenClawGatewayRequest.make({
          message: INSTRUCTION,
          idempotencyKey: IDEMPOTENCY_KEY,
          timeout: 30,
        }),
      );
    }),
  );
}

function requireClientOptions(
  fixture: RoundTripFixture,
): Parameters<OpenClawGatewayClientFactory>[0] {
  if (fixture.clientOptions === undefined) {
    throw new Error("gateway client was not constructed");
  }
  return fixture.clientOptions;
}

function requireRequestOptions(
  observation: ClientObservation,
): NonNullable<ClientObservation["options"]> {
  if (observation.options === undefined) {
    throw new Error("gateway request options were not supplied");
  }
  return observation.options;
}

function assertRoundTrip(
  fixture: RoundTripFixture,
  request: ClientObservation,
  response: OpenClawGatewayResponse,
): void {
  const clientOptions = requireClientOptions(fixture);
  const requestOptions = requireRequestOptions(request);
  assert.strictEqual(clientOptions.url, GATEWAY_URL);
  assert.strictEqual(clientOptions.token, GATEWAY_TOKEN);
  assert.strictEqual(clientOptions.role, OPERATOR_ROLE);
  assert.deepStrictEqual(clientOptions.scopes, [OPERATOR_WRITE_SCOPE]);
  assert.strictEqual(clientOptions.deviceIdentity, DEVICE_IDENTITY);
  assert.isUndefined(clientOptions.env);
  assert.strictEqual(request.method, AGENT_METHOD);
  assert.deepStrictEqual(request.params, {
    message: INSTRUCTION,
    idempotencyKey: IDEMPOTENCY_KEY,
    deliver: false,
    agentId: AGENT_NAME,
    timeout: 30,
  });
  assert.strictEqual(requestOptions.expectFinal, true);
  assert.isNull(requestOptions.timeoutMs);
  assert.instanceOf(requestOptions.signal, AbortSignal);
  assert.instanceOf(response, OpenClawGatewaySucceeded);
  assert.strictEqual(response.runId, RUN_ID);
  assert.strictEqual(response.status, "ok");
  assert.strictEqual(response.result?.payloads?.[0]?.text, RESPONSE_TEXT);
  assert.deepStrictEqual(
    Object.keys(response).sort((left, right) => left.localeCompare(right)),
    ["result", "runId", "status", "summary"],
  );
}

function gatewayRoundTripTest() {
  return Effect.gen(function* () {
    const fixture: RoundTripFixture = {
      exitCode: yield* Deferred.make<ExitCode>(),
      requested: yield* Deferred.make<ClientObservation>(),
      stopped: yield* Deferred.make<undefined>(),
    };
    const response = yield* runRoundTrip(fixture);
    const request = yield* Deferred.await(fixture.requested);
    yield* Deferred.await(fixture.stopped);
    assertRoundTrip(fixture, request, response);
  });
}

function readyClient(response: unknown): OpenClawGatewayClientFactory {
  return (options) => ({
    start: () => {
      notifyHello(options);
    },
    stop: () => undefined,
    stopAndWait: () => Promise.resolve(),
    request: () => Promise.resolve(response),
  });
}

function invalidResponseTest() {
  return Effect.gen(function* () {
    const exitCode = yield* Deferred.make<ExitCode>();
    const failure = yield* Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* acquireGateway(
          processSession(exitCode),
          readyClient({
            runId: RUN_ID,
            status: "surprise",
            summary: "not part of the declared boundary",
          }),
        );
        return yield* gateway
          .agent(
            OpenClawGatewayRequest.make({
              message: "Do the task.",
              idempotencyKey: IDEMPOTENCY_KEY,
            }),
          )
          .pipe(Effect.flip);
      }),
    );

    assert.instanceOf(failure, OpenClawGatewayRequestError);
    assert.include(failure.detail, "invalid terminal agent response");
  });
}

function boundedResponseTextTest() {
  return Effect.gen(function* () {
    const exitCode = yield* Deferred.make<ExitCode>();
    const text = "x".repeat(GATEWAY_TEXT_MAX_LENGTH);
    const response = yield* Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* acquireGateway(
          processSession(exitCode),
          readyClient({
            runId: RUN_ID,
            status: "ok",
            summary: "completed",
            result: { payloads: [{ text }] },
          }),
        );
        return yield* gateway.agent(
          OpenClawGatewayRequest.make({
            message: "Return the bounded response.",
            idempotencyKey: IDEMPOTENCY_KEY,
          }),
        );
      }),
    );

    assert.instanceOf(response, OpenClawGatewaySucceeded);
    assert.strictEqual(
      response.result.payloads?.[0]?.text?.length,
      text.length,
    );
  });
}

function nullableMediaUrlTest() {
  return Effect.gen(function* () {
    const exitCode = yield* Deferred.make<ExitCode>();
    const response = yield* Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* acquireGateway(
          processSession(exitCode),
          readyClient({
            runId: RUN_ID,
            status: "ok",
            summary: "completed",
            result: {
              payloads: [{ text: RESPONSE_TEXT, mediaUrl: null }],
            },
          }),
        );
        return yield* gateway.agent(
          OpenClawGatewayRequest.make({
            message: "Return the native message result.",
            idempotencyKey: IDEMPOTENCY_KEY,
          }),
        );
      }),
    );

    assert.instanceOf(response, OpenClawGatewaySucceeded);
    assert.isNull(response.result.payloads?.[0]?.mediaUrl);
  });
}

function oversizedResponseTextTest() {
  return Effect.gen(function* () {
    const exitCode = yield* Deferred.make<ExitCode>();
    const failure = yield* Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* acquireGateway(
          processSession(exitCode),
          readyClient({
            runId: RUN_ID,
            status: "ok",
            summary: "completed",
            result: {
              payloads: [
                {
                  text: "x".repeat(GATEWAY_TEXT_MAX_LENGTH + 1),
                },
              ],
            },
          }),
        );
        return yield* gateway
          .agent(
            OpenClawGatewayRequest.make({
              message: "Return the oversized response.",
              idempotencyKey: IDEMPOTENCY_KEY,
            }),
          )
          .pipe(Effect.flip);
      }),
    );

    assert.instanceOf(failure, OpenClawGatewayRequestError);
    assert.include(failure.detail, "invalid terminal agent response");
  });
}

function timeoutResponseTest() {
  return Effect.gen(function* () {
    const exitCode = yield* Deferred.make<ExitCode>();
    const response = yield* Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* acquireGateway(
          processSession(exitCode),
          readyClient({
            runId: RUN_ID,
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
            timeoutPhase: PROVIDER_TIMEOUT_PHASE,
            providerStarted: true,
          }),
        );
        return yield* gateway.agent(
          OpenClawGatewayRequest.make({
            message: "Do the bounded task.",
            idempotencyKey: IDEMPOTENCY_KEY,
          }),
        );
      }),
    );

    assert.instanceOf(response, OpenClawGatewayTimedOut);
    assert.strictEqual(response.timeoutPhase, PROVIDER_TIMEOUT_PHASE);
    assert.isTrue(response.providerStarted);
  });
}

function exitBeforeHelloTest() {
  return Effect.gen(function* () {
    const exitCode = yield* Deferred.make<ExitCode>();
    const started = yield* Deferred.make<undefined>();
    const stopped = yield* Deferred.make<undefined>();
    const makeClient: OpenClawGatewayClientFactory = () => ({
      start: () => {
        complete(started);
      },
      stop: () => {
        complete(stopped);
      },
      stopAndWait: () => {
        complete(stopped);
        return Promise.resolve();
      },
      request: () => Promise.resolve({}),
    });
    const acquiring = yield* Effect.scoped(
      acquireGateway(processSession(exitCode), makeClient),
    ).pipe(Effect.flip, Effect.fork);
    yield* Deferred.await(started);
    yield* Deferred.succeed(exitCode, processExitCode(27));
    const failure = yield* Fiber.join(acquiring);
    yield* Deferred.await(stopped);

    assert.instanceOf(failure, Error);
    assert.include(failure.message, "exitCode=27");
  });
}

function privateNetworkGatewayTest() {
  return Effect.gen(function* () {
    let clientOptions: Parameters<OpenClawGatewayClientFactory>[0] | undefined;
    const session: OpenClawGatewaySession = {
      gatewayUrl: REMOTE_GATEWAY_URL,
      gatewayToken: Redacted.make(GATEWAY_TOKEN),
      deviceIdentity: DEVICE_IDENTITY,
      agentName: AGENT_NAME,
      stopped: Effect.never,
    };
    const delegate = readyClient({});

    yield* Effect.scoped(
      acquireGateway(session, (options) => {
        clientOptions = options;
        return delegate(options);
      }),
    );

    assert.isDefined(clientOptions);
    assert.strictEqual(clientOptions?.url, REMOTE_GATEWAY_URL);
    assert.deepStrictEqual(clientOptions?.env, {
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
    });
  });
}

describe("OpenClaw principal gateway", () => {
  test(
    "binds the scoped client to its principal agent and decodes the response",
    gatewayRoundTripTest,
  );
  test(
    "preserves OpenClaw timeout as a terminal response",
    timeoutResponseTest,
  );
  test(
    "accepts native output at the application boundary",
    boundedResponseTextTest,
  );
  test("accepts OpenClaw's nullable media URL", nullableMediaUrlTest);
  test(
    "rejects native output above the application boundary",
    oversizedResponseTextTest,
  );
  test("rejects responses outside its declared schema", invalidResponseTest);
  test(
    "fails and releases the client when the process exits before hello",
    exitBeforeHelloTest,
  );
  test(
    "opts into OpenClaw's private-network websocket client for a remote Pod",
    privateNetworkGatewayTest,
  );
});
