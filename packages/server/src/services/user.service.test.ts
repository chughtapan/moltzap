import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { InProcessUserService, WebhookUserService } from "./user.service.js";
import { WebhookError, type WebhookClient } from "../adapters/webhook.js";
import { makeFakeWebhookClient } from "../test-utils/fakes.js";
import { UserId } from "../app/types.js";

describe("InProcessUserService", () => {
  it("always returns { valid: true }", async () => {
    const svc = new InProcessUserService();
    expect(
      await Effect.runPromise(svc.validateUser(UserId("any-user"))),
    ).toEqual({
      valid: true,
    });
    expect(await Effect.runPromise(svc.validateUser(UserId("")))).toEqual({
      valid: true,
    });
  });
});

describe("WebhookUserService", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;

  /**
   * Create a WebhookUserService wired to a typed fake client. The fake's
   * `callSync` is a `vi.fn` so we still get call-assertion ergonomics, but
   * the overall shape is enforced against the real `WebhookClient` via
   * `makeFakeWebhookClient`'s `Pick<>` constraint — a signature change in
   * `callSync` fails compilation here rather than at runtime.
   *
   * Note: `callSync` is generic (`<T>(...) => Promise<T>`), which `vi.fn`
   * can't represent directly — Mock's call signature is non-generic. We
   * cast via `as` after asserting the fake body's shape via the spread into
   * `makeFakeWebhookClient`, so a drift in the non-generic portion of the
   * signature still fails compilation.
   */
  function createService() {
    const callSync =
      vi.fn<
        (opts: {
          url: string;
          event: string;
          body: unknown;
          timeoutMs: number;
        }) => Promise<unknown>
      >();
    const client = makeFakeWebhookClient({
      callSync: callSync as unknown as WebhookClient["callSync"],
    });
    const svc = new WebhookUserService(
      client,
      "https://hook.test/users",
      5000,
      mockLogger,
    );
    return { svc, callSync };
  }

  it("calls WebhookClient.callSync with correct params", async () => {
    const { svc, callSync } = createService();
    callSync.mockResolvedValue({ valid: true });

    const result = await Effect.runPromise(svc.validateUser(UserId("user-42")));

    expect(result).toEqual({ valid: true });
    expect(callSync).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://hook.test/users",
        event: "users.validate",
        body: { userId: "user-42" },
        timeoutMs: 5000,
      }),
    );
  });

  it("returns { valid: false } when webhook returns it", async () => {
    const { svc, callSync } = createService();
    callSync.mockResolvedValue({ valid: false });

    expect(
      await Effect.runPromise(svc.validateUser(UserId("bad-user"))),
    ).toEqual({
      valid: false,
    });
  });

  it("returns { valid: false } on WebhookError", async () => {
    const { svc, callSync } = createService();
    callSync.mockRejectedValue(new WebhookError("timeout", 0));

    expect(await Effect.runPromise(svc.validateUser(UserId("user-1")))).toEqual(
      {
        valid: false,
      },
    );
  });

  it("returns { valid: false } on network error", async () => {
    const { svc, callSync } = createService();
    callSync.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await Effect.runPromise(svc.validateUser(UserId("user-1")))).toEqual(
      {
        valid: false,
      },
    );
  });
});
