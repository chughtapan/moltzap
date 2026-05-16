import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schedule,
  Schema,
} from "effect";
import {
  WebhookClient,
  WebhookDecodeError,
  WebhookHttpError,
  WebhookNetworkError,
  WebhookTimeoutError,
} from "./webhook.js";

const it = effectIt.live;

const OkSchema = Schema.Struct({ ok: Schema.Boolean });
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const FAST_WEBHOOK_TIMEOUT_MS = 50;
const WEBHOOK_TIMEOUT_MS = 5000;
const INTERRUPT_TIMEOUT_MS = 60_000;
const WEBHOOK_USERS_URL = "https://hook.test/users";
const WEBHOOK_TEST_URL = "https://hook.test/x";
const USERS_VALIDATE_EVENT = "users.validate";
const TEST_EVENT = "test";
const TEST_TIMEOUT_EVENT = "test.timeout";
const TEST_SCHEMA_EVENT = "test.schema";
const TEST_NETWORK_EVENT = "test.net";
const TEST_INTERRUPT_EVENT = "test.interrupt";
const FORBIDDEN_BODY = "forbidden";
const NETWORK_ERROR_MESSAGE = "ECONNREFUSED";
const ABORTED_MESSAGE = "aborted";
const POST_METHOD = "POST";
const OK_RESPONSE_BODY = { ok: true } as const;
const INVALID_RESPONSE_BODY = { ok: "not a boolean" } as const;
const CAPTURED_SIGNAL_RETRY_COUNT = 20;

class CapturedSignalMissing extends Data.TaggedError(
  "CapturedSignalMissing",
)<{}> {}

class FetchRejected extends Data.TaggedError("FetchRejected")<{
  readonly message: string;
}> {}

class FetchAborted extends Data.TaggedError("FetchAborted")<{
  readonly message: string;
}> {}

let client: WebhookClient;

beforeEach(() => {
  client = new WebhookClient(5);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebhookClient.call success", () => {
  it("returns parsed JSON on 200 response", () => returnsParsedJson());
});

describe("WebhookClient.call remote failures", () => {
  it("fails with WebhookHttpError on non-2xx status", () =>
    failsWithHttpError());

  it("fails with WebhookDecodeError when body does not match schema", () =>
    failsWithDecodeError());
});

describe("WebhookClient.call transport failures", () => {
  it("fails with WebhookTimeoutError when timeoutMs elapses", () =>
    failsWithTimeoutError());

  it("fails with WebhookNetworkError on fetch rejection", () =>
    failsWithNetworkError());
});

describe("WebhookClient.call interruption", () => {
  it("aborts fetch via AbortSignal on fiber interrupt", () =>
    abortsFetchOnInterrupt());
});

function returnsParsedJson() {
  vi.mocked(fetch).mockResolvedValue(jsonResponse(OK_RESPONSE_BODY, HTTP_OK));

  return Effect.gen(function* () {
    const result = yield* client.call({
      url: WEBHOOK_USERS_URL,
      event: USERS_VALIDATE_EVENT,
      body: { userId: "u1" },
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      schema: OkSchema,
    });

    expect(result).toEqual(OK_RESPONSE_BODY);
    expect(fetch).toHaveBeenCalledWith(
      WEBHOOK_USERS_URL,
      expect.objectContaining({
        method: POST_METHOD,
        headers: expect.objectContaining({
          "X-MoltZap-Event": USERS_VALIDATE_EVENT,
        }),
      }),
    );
  });
}

function failsWithHttpError() {
  vi.mocked(fetch).mockResolvedValue(
    new Response(FORBIDDEN_BODY, { status: HTTP_FORBIDDEN }),
  );

  return Effect.gen(function* () {
    const error = expectHttpError(
      yield* Effect.exit(
        client.call({
          url: WEBHOOK_TEST_URL,
          event: TEST_EVENT,
          body: {},
          timeoutMs: WEBHOOK_TIMEOUT_MS,
          schema: Schema.Unknown,
        }),
      ),
    );

    expect(error.status).toBe(HTTP_FORBIDDEN);
    expect(error.body).toBe(FORBIDDEN_BODY);
  });
}

function failsWithTimeoutError() {
  vi.mocked(fetch).mockImplementation(() => Effect.runPromise(Effect.never));

  return Effect.gen(function* () {
    const error = expectTimeoutError(
      yield* Effect.exit(
        client.call({
          url: WEBHOOK_TEST_URL,
          event: TEST_TIMEOUT_EVENT,
          body: {},
          timeoutMs: FAST_WEBHOOK_TIMEOUT_MS,
          schema: Schema.Unknown,
        }),
      ),
    );

    expect(error.timeoutMs).toBe(FAST_WEBHOOK_TIMEOUT_MS);
  });
}

function failsWithDecodeError() {
  vi.mocked(fetch).mockResolvedValue(
    jsonResponse(INVALID_RESPONSE_BODY, HTTP_OK),
  );

  return Effect.gen(function* () {
    const error = expectDecodeError(
      yield* Effect.exit(
        client.call({
          url: WEBHOOK_TEST_URL,
          event: TEST_SCHEMA_EVENT,
          body: {},
          timeoutMs: WEBHOOK_TIMEOUT_MS,
          schema: OkSchema,
        }),
      ),
    );

    expect(error.event).toBe(TEST_SCHEMA_EVENT);
  });
}

function failsWithNetworkError() {
  const cause = new FetchRejected({ message: NETWORK_ERROR_MESSAGE });
  vi.mocked(fetch).mockRejectedValue(cause);

  return Effect.gen(function* () {
    const error = expectNetworkError(
      yield* Effect.exit(
        client.call({
          url: WEBHOOK_TEST_URL,
          event: TEST_NETWORK_EVENT,
          body: {},
          timeoutMs: WEBHOOK_TIMEOUT_MS,
          schema: Schema.Unknown,
        }),
      ),
    );

    expect(error.cause).toBe(cause);
  });
}

function abortsFetchOnInterrupt() {
  let capturedSignal: AbortSignal | undefined;
  vi.mocked(fetch).mockImplementation((_url, init) => {
    capturedSignal = (init as RequestInit).signal as AbortSignal;
    return new Promise((_resolve, reject) => {
      capturedSignal?.addEventListener("abort", () =>
        reject(new FetchAborted({ message: ABORTED_MESSAGE })),
      );
    });
  });

  return Effect.gen(function* () {
    const fiber = yield* Effect.fork(
      client.call({
        url: WEBHOOK_TEST_URL,
        event: TEST_INTERRUPT_EVENT,
        body: {},
        timeoutMs: INTERRUPT_TIMEOUT_MS,
        schema: Schema.Unknown,
      }),
    );

    const signal = yield* waitForCapturedSignal(() => capturedSignal);
    expect(signal.aborted).toBe(false);

    yield* Fiber.interrupt(fiber);
    expect(signal.aborted).toBe(true);
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status });
}

function expectFailure(exit: Exit.Exit<unknown, unknown>): unknown {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) expect.fail("expected failure exit");
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) expect.fail("expected typed failure");
  return failure.value;
}

function expectHttpError(exit: Exit.Exit<unknown, unknown>): WebhookHttpError {
  const failure = expectFailure(exit);
  expect(failure).toBeInstanceOf(WebhookHttpError);
  return failure as WebhookHttpError;
}

function expectTimeoutError(
  exit: Exit.Exit<unknown, unknown>,
): WebhookTimeoutError {
  const failure = expectFailure(exit);
  expect(failure).toBeInstanceOf(WebhookTimeoutError);
  return failure as WebhookTimeoutError;
}

function expectDecodeError(
  exit: Exit.Exit<unknown, unknown>,
): WebhookDecodeError {
  const failure = expectFailure(exit);
  expect(failure).toBeInstanceOf(WebhookDecodeError);
  return failure as WebhookDecodeError;
}

function expectNetworkError(
  exit: Exit.Exit<unknown, unknown>,
): WebhookNetworkError {
  const failure = expectFailure(exit);
  expect(failure).toBeInstanceOf(WebhookNetworkError);
  return failure as WebhookNetworkError;
}

function waitForCapturedSignal(
  read: () => AbortSignal | undefined,
): Effect.Effect<AbortSignal> {
  return Effect.sync(read).pipe(
    Effect.flatMap((signal) =>
      signal
        ? Effect.succeed(signal)
        : Effect.fail(new CapturedSignalMissing()),
    ),
    Effect.retry({
      times: CAPTURED_SIGNAL_RETRY_COUNT,
      schedule: Schedule.spaced(Duration.millis(1)),
    }),
    Effect.orDie,
  );
}
