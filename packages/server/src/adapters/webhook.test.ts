import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import {
  AsyncWebhookAdapter,
  WebhookClient,
  WebhookDestroyedError,
  WebhookHttpError,
  WebhookNetworkError,
  WebhookTimeoutError,
} from "./webhook.js";

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
      client.call<{ ok: boolean }>({
        url: "https://hook.test/users",
        event: "users.validate",
        body: { userId: "u1" },
        timeoutMs: 5000,
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
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const err = Cause.failureOption(exit.cause);
    if (err._tag !== "Some") throw new Error("expected failure");
    expect(err.value._tag).toBe("WebhookTimeoutError");
    expect((err.value as WebhookTimeoutError).timeoutMs).toBe(50);
  });

  it("fails with WebhookNetworkError on fetch rejection", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const exit = await Effect.runPromiseExit(
      client.call({
        url: "https://hook.test/x",
        event: "test.net",
        body: {},
        timeoutMs: 5000,
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
      }),
    );

    // Give the fetch mock one tick to register.
    await new Promise((r) => setTimeout(r, 0));
    expect(capturedSignal?.aborted).toBe(false);

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(capturedSignal?.aborted).toBe(true);
  });
});

// -- AsyncWebhookAdapter (permissions) --------------------------------------

describe("AsyncWebhookAdapter.send", () => {
  let adapter: AsyncWebhookAdapter;

  beforeEach(() => {
    adapter = new AsyncWebhookAdapter(5);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    await Effect.runPromise(adapter.shutdown);
    vi.restoreAllMocks();
  });

  it("resolves with access when callback arrives", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const fiber = Effect.runFork(
      adapter.send({
        url: "https://hook.test/perms",
        requestId: "req-1",
        callbackUrl: "https://me/callback",
        callbackToken: "token",
        body: { agentId: "a1" },
        timeoutMs: 10_000,
      }),
    );

    // Give the fetch promise + Deferred registration a tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(fetch).toHaveBeenCalledWith(
      "https://hook.test/perms",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-MoltZap-Callback-URL": "https://me/callback",
          "X-MoltZap-Callback-Token": "token",
        }),
      }),
    );

    const found = await Effect.runPromise(
      adapter.resolveCallback("req-1", ["read", "write"]),
    );
    expect(found).toBe(true);

    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual(["read", "write"]);
  });

  it("fails with WebhookHttpError on non-202 response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("bad", { status: 500 }));

    const exit = await Effect.runPromiseExit(
      adapter.send({
        url: "https://hook.test/perms",
        requestId: "req-err",
        callbackUrl: "https://me/cb",
        callbackToken: "t",
        body: {},
        timeoutMs: 5000,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const err = Cause.failureOption(exit.cause);
    if (err._tag !== "Some") throw new Error("expected failure");
    expect(err.value._tag).toBe("WebhookHttpError");
    expect((err.value as WebhookHttpError).status).toBe(500);
  });

  it("returns false for resolveCallback with unknown request_id", async () => {
    const found = await Effect.runPromise(
      adapter.resolveCallback("unknown-id", ["read"]),
    );
    expect(found).toBe(false);
  });

  it("returns true for duplicate resolveCallback within TTL (idempotency)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const fiber = Effect.runFork(
      adapter.send({
        url: "https://hook.test/perms",
        requestId: "req-dup",
        callbackUrl: "https://me/cb",
        callbackToken: "t",
        body: {},
        timeoutMs: 30_000,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(
      await Effect.runPromise(adapter.resolveCallback("req-dup", ["read"])),
    ).toBe(true);
    await Effect.runPromise(Fiber.await(fiber));
    expect(
      await Effect.runPromise(adapter.resolveCallback("req-dup", ["read"])),
    ).toBe(true);
  });

  it("fails with WebhookTimeoutError when callback never arrives", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const exit = await Effect.runPromiseExit(
      adapter.send({
        url: "https://hook.test/perms",
        requestId: "req-timeout",
        callbackUrl: "https://me/cb",
        callbackToken: "t",
        body: {},
        timeoutMs: 10,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const err = Cause.failureOption(exit.cause);
    if (err._tag !== "Some") throw new Error("expected failure");
    expect(err.value._tag).toBe("WebhookTimeoutError");
  });

  it("shutdown fails all pending requests with WebhookDestroyedError", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const fiber = Effect.runFork(
      adapter.send({
        url: "https://hook.test/perms",
        requestId: "req-destroy",
        callbackUrl: "https://me/cb",
        callbackToken: "t",
        body: {},
        timeoutMs: 60_000,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    await Effect.runPromise(adapter.shutdown);

    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const err = Cause.failureOption(exit.cause);
    if (err._tag !== "Some") throw new Error("expected failure");
    expect(err.value._tag).toBe("WebhookDestroyedError");
    expect((err.value as WebhookDestroyedError).requestId).toBe("req-destroy");
  });

  it("removes pending entry when the send fiber is interrupted", async () => {
    // 202 ack → the fiber parks on Deferred.await. Interrupt it and
    // confirm the pending map is cleared (resolveCallback returns false).
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const fiber = Effect.runFork(
      adapter.send({
        url: "https://hook.test/perms",
        requestId: "req-interrupt",
        callbackUrl: "https://me/cb",
        callbackToken: "t",
        body: {},
        timeoutMs: 60_000,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    await Effect.runPromise(Fiber.interrupt(fiber));
    await new Promise((r) => setTimeout(r, 0));

    const found = await Effect.runPromise(
      adapter.resolveCallback("req-interrupt", ["read"]),
    );
    expect(found).toBe(false);
  });
});
