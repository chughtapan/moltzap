import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebhookClient, AsyncWebhookAdapter, WebhookError } from "./webhook.js";

// -- WebhookClient (sync) ---------------------------------------------------

describe("WebhookClient", () => {
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

    const result = await client.callSync<{ ok: boolean }>({
      url: "https://hook.test/users",
      event: "users.validate",
      body: { userId: "u1" },
      timeoutMs: 5000,
    });

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

  it("throws WebhookError with status code on non-200 response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );

    await expect(
      client.callSync({
        url: "https://hook.test/x",
        event: "test",
        body: {},
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(WebhookError);

    try {
      await client.callSync({
        url: "https://hook.test/x",
        event: "test",
        body: {},
        timeoutMs: 5000,
      });
    } catch (err) {
      expect((err as WebhookError).statusCode).toBe(403);
      expect((err as WebhookError).message).toContain("403");
    }
  });

  it("throws WebhookError on timeout", async () => {
    const timeoutErr = new DOMException(
      "The operation was aborted",
      "TimeoutError",
    );
    vi.mocked(fetch).mockRejectedValue(timeoutErr);

    await expect(
      client.callSync({
        url: "https://hook.test/x",
        event: "test.timeout",
        body: {},
        timeoutMs: 100,
      }),
    ).rejects.toThrow(WebhookError);

    try {
      await client.callSync({
        url: "https://hook.test/x",
        event: "test.timeout",
        body: {},
        timeoutMs: 100,
      });
    } catch (err) {
      expect((err as WebhookError).statusCode).toBe(0);
      expect((err as WebhookError).message).toContain("timed out");
    }
  });

  it("throws WebhookError on network failure", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      client.callSync({
        url: "https://hook.test/x",
        event: "test.net",
        body: {},
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(WebhookError);

    try {
      await client.callSync({
        url: "https://hook.test/x",
        event: "test.net",
        body: {},
        timeoutMs: 5000,
      });
    } catch (err) {
      expect((err as WebhookError).message).toContain("ECONNREFUSED");
    }
  });
});

// -- AsyncWebhookAdapter (permissions) --------------------------------------

describe("AsyncWebhookAdapter", () => {
  let adapter: AsyncWebhookAdapter;
  let needsCleanup: boolean;

  beforeEach(() => {
    adapter = new AsyncWebhookAdapter(5);
    needsCleanup = true;
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (needsCleanup) adapter.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Flush microtasks so sendRequest progresses past `await fetch()` and registers the pending entry. */
  async function flushSendRequest() {
    await vi.advanceTimersByTimeAsync(0);
  }

  it("sends request and resolves via callback", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const promise = adapter.sendRequest({
      url: "https://hook.test/perms",
      requestId: "req-1",
      callbackUrl: "https://me/callback",
      callbackToken: "token",
      body: { agentId: "a1" },
      timeoutMs: 10000,
    });

    await flushSendRequest();

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

    const resolved = adapter.resolveCallback("req-1", ["read", "write"]);
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result).toEqual(["read", "write"]);
  });

  it("throws WebhookError when server returns non-202", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("bad", { status: 500 }));

    const promise = adapter.sendRequest({
      url: "https://hook.test/perms",
      requestId: "req-err",
      callbackUrl: "https://me/cb",
      callbackToken: "t",
      body: {},
      timeoutMs: 5000,
    });

    // Attach handler before flushing to avoid unhandled rejection warning
    const assertion = expect(promise).rejects.toThrow(WebhookError);
    await flushSendRequest();
    await assertion;
  });

  it("returns false for resolveCallback with unknown request_id", () => {
    expect(adapter.resolveCallback("unknown-id", ["read"])).toBe(false);
  });

  it("returns true for duplicate resolveCallback (idempotency)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const promise = adapter.sendRequest({
      url: "https://hook.test/perms",
      requestId: "req-dup",
      callbackUrl: "https://me/cb",
      callbackToken: "t",
      body: {},
      timeoutMs: 30000,
    });

    await flushSendRequest();

    expect(adapter.resolveCallback("req-dup", ["read"])).toBe(true);
    await promise;

    expect(adapter.resolveCallback("req-dup", ["read"])).toBe(true);
  });

  it("rejects pending promise on timeout", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const promise = adapter.sendRequest({
      url: "https://hook.test/perms",
      requestId: "req-timeout",
      callbackUrl: "https://me/cb",
      callbackToken: "t",
      body: {},
      timeoutMs: 5000,
    });

    await flushSendRequest();

    // Attach handler before advancing timers to avoid unhandled rejection warning
    const assertion = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  it("resolveCallback returns false after TTL expiry and drops the id", async () => {
    // After a callback resolves, the adapter remembers the id for
    // RESOLVED_TTL_MS (5 minutes) to make repeat callbacks idempotent.
    // Once the TTL lapses, the first repeat call must BOTH drop the id
    // from the `resolved` map AND return false — otherwise a very late
    // duplicate would masquerade as a fresh, unknown request.
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const promise = adapter.sendRequest({
      url: "https://hook.test/perms",
      requestId: "req-ttl",
      callbackUrl: "https://me/cb",
      callbackToken: "t",
      body: {},
      timeoutMs: 60000,
    });

    await flushSendRequest();

    // Initial resolution: recorded in `resolved`, promise completes.
    expect(adapter.resolveCallback("req-ttl", ["read"])).toBe(true);
    await promise;

    // Still within TTL — duplicate is idempotent, returns true.
    expect(adapter.resolveCallback("req-ttl", ["read"])).toBe(true);

    // Advance past the 5-minute TTL window.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    // First call after expiry deletes the stale entry and returns false.
    expect(adapter.resolveCallback("req-ttl", ["read"])).toBe(false);

    // Second call confirms the id is no longer in `resolved`: it must
    // now fall through to the "no pending entry" branch, which also
    // returns false. This double-checks the delete in the previous step.
    expect(adapter.resolveCallback("req-ttl", ["read"])).toBe(false);
  });

  it("destroy() rejects all pending requests", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const promise = adapter.sendRequest({
      url: "https://hook.test/perms",
      requestId: "req-destroy",
      callbackUrl: "https://me/cb",
      callbackToken: "t",
      body: {},
      timeoutMs: 60000,
    });

    await flushSendRequest();
    adapter.destroy();
    needsCleanup = false;

    await expect(promise).rejects.toThrow(WebhookError);
    await expect(promise).rejects.toThrow("Adapter destroyed");
  });
});

// -- WebhookError -----------------------------------------------------------

describe("WebhookError", () => {
  it("has correct name, message, and statusCode", () => {
    const err = new WebhookError("bad request", 400);
    expect(err.name).toBe("WebhookError");
    expect(err.message).toBe("bad request");
    expect(err.statusCode).toBe(400);
    expect(err).toBeInstanceOf(Error);
  });
});
