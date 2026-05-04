import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Cause, Effect, Exit, Fiber, Schema } from "effect";
import {
  WebhookClient,
  WebhookDecodeError,
  WebhookHttpError,
  WebhookNetworkError,
  WebhookTimeoutError,
} from "./webhook.js";

const OkSchema = Schema.Struct({ ok: Schema.Boolean });

// -- WebhookClient (sync) ---------------------------------------------------

describe("WebhookClient.call", () => {
  let client: WebhookClient;

  beforeEach(() => {
    client = new WebhookClient(5);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed JSON on 200 response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const result = await Effect.runPromise(
      client.call({
        url: "https://hook.test/users",
        event: "users.validate",
        body: { userId: "u1" },
        timeoutMs: 5000,
        schema: OkSchema,
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://hook.test/users",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-MoltZap-Event": "users.validate",
        }),
      }),
    );
  });

  it("fails with WebhookHttpError on non-2xx status", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );

    const exit = await Effect.runPromiseExit(
      client.call({
        url: "https://hook.test/x",
        event: "test",
        body: {},
        timeoutMs: 5000,
        schema: Schema.Unknown,
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = Cause.failureOption(exit.cause);
    expect(err._tag).toBe("Some");
    if (err._tag !== "Some") return;
    expect(err.value._tag).toBe("WebhookHttpError");
    const httpErr = err.value as WebhookHttpError;
    expect(httpErr.status).toBe(403);
    expect(httpErr.body).toBe("forbidden");
  });

  it("fails with WebhookTimeoutError when timeoutMs elapses", async () => {
    // fetch never resolves — Effect.timeoutFail triggers on the real
    // clock. We keep the budget small (50ms) so the test stays fast.
    vi.mocked(fetch).mockImplementation(
      () => new Promise(() => undefined) as never,
    );

    const exit = await Effect.runPromiseExit(
      client.call({
        url: "https://hook.test/x",
        event: "test.timeout",
        body: {},
        timeoutMs: 50,
        schema: Schema.Unknown,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const err = Cause.failureOption(exit.cause);
    if (err._tag !== "Some") throw new Error("expected failure");
    expect(err.value._tag).toBe("WebhookTimeoutError");
    expect((err.value as WebhookTimeoutError).timeoutMs).toBe(50);
  });

  it("fails with WebhookDecodeError when body doesn't match schema", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: "not a boolean" }), { status: 200 }),
    );

    const exit = await Effect.runPromiseExit(
      client.call({
        url: "https://hook.test/x",
        event: "test.schema",
        body: {},
        timeoutMs: 5000,
        schema: OkSchema,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const err = Cause.failureOption(exit.cause);
    if (err._tag !== "Some") throw new Error("expected failure");
    expect(err.value._tag).toBe("WebhookDecodeError");
    expect((err.value as WebhookDecodeError).event).toBe("test.schema");
  });

  it("fails with WebhookNetworkError on fetch rejection", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const exit = await Effect.runPromiseExit(
      client.call({
        url: "https://hook.test/x",
        event: "test.net",
        body: {},
        timeoutMs: 5000,
        schema: Schema.Unknown,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const err = Cause.failureOption(exit.cause);
    if (err._tag !== "Some") throw new Error("expected failure");
    expect(err.value._tag).toBe("WebhookNetworkError");
    const netErr = err.value as WebhookNetworkError;
    expect(netErr.cause).toBeInstanceOf(Error);
    expect((netErr.cause as Error).message).toBe("ECONNREFUSED");
  });

  it("aborts fetch via AbortSignal on fiber interrupt", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit).signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    });

    const fiber = Effect.runFork(
      client.call({
        url: "https://hook.test/x",
        event: "test.interrupt",
        body: {},
        timeoutMs: 60000,
        schema: Schema.Unknown,
      }),
    );

    // Give the fetch mock one tick to register.
    await new Promise((r) => setTimeout(r, 0));
    expect(capturedSignal?.aborted).toBe(false);

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(capturedSignal?.aborted).toBe(true);
  });
});
