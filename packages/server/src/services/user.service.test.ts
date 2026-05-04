import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { InProcessUserService, WebhookUserService } from "./user.service.js";
import {
  WebhookNetworkError,
  WebhookTimeoutError,
  type WebhookClient,
} from "../adapters/webhook.js";
import { makeFakeWebhookClient } from "../test-utils/fakes.js";
import { UserId } from "../app/types.js";

// UserId now decodes through @moltzap/protocol's branded UUID schema; tests
// must pass UUID-shaped fixtures or the constructor throws at decode time.
const ANY_USER = "00000000-0000-4000-8000-00000000a17a";
const BAD_USER = "00000000-0000-4000-8000-00000000bad0";
const USER_42 = "00000000-0000-4000-8000-000000000042";
const USER_1 = "00000000-0000-4000-8000-000000000001";

describe("InProcessUserService", () => {
  it("always returns { valid: true }", async () => {
    const svc = new InProcessUserService();
    expect(await Effect.runPromise(svc.validateUser(UserId(ANY_USER)))).toEqual(
      {
        valid: true,
      },
    );
    expect(await Effect.runPromise(svc.validateUser(UserId(BAD_USER)))).toEqual(
      {
        valid: true,
      },
    );
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
   * Build a WebhookUserService wired to a typed fake client. `call` is a
   * `vi.fn` for call-assertion ergonomics; `makeFakeWebhookClient`'s
   * `Pick<>` constraint makes a signature drift in the real client a
   * compile error here rather than a silent runtime mismatch.
   */
  function createService() {
    const call =
      vi.fn<
        (opts: {
          url: string;
          event: string;
          body: unknown;
          timeoutMs: number;
        }) => Effect.Effect<unknown, unknown>
      >();
    const client = makeFakeWebhookClient({
      call: call as WebhookClient["call"],
    });
    const svc = new WebhookUserService(
      client,
      "https://hook.test/users",
      5000,
      mockLogger,
    );
    return { svc, call };
  }

  it("calls WebhookClient.call with correct params", async () => {
    const { svc, call } = createService();
    call.mockReturnValue(Effect.succeed({ valid: true }));

    const result = await Effect.runPromise(svc.validateUser(UserId(USER_42)));

    expect(result).toEqual({ valid: true });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://hook.test/users",
        event: "users.validate",
        body: { userId: USER_42 },
        timeoutMs: 5000,
      }),
    );
  });

  it("returns { valid: false } when webhook returns it", async () => {
    const { svc, call } = createService();
    call.mockReturnValue(Effect.succeed({ valid: false }));

    expect(await Effect.runPromise(svc.validateUser(UserId(BAD_USER)))).toEqual(
      {
        valid: false,
      },
    );
  });

  it("returns { valid: false } on WebhookTimeoutError", async () => {
    const { svc, call } = createService();
    call.mockReturnValue(
      Effect.fail(
        new WebhookTimeoutError({
          url: "https://hook.test/users",
          event: "users.validate",
          timeoutMs: 5000,
        }),
      ),
    );

    expect(await Effect.runPromise(svc.validateUser(UserId(USER_1)))).toEqual({
      valid: false,
    });
  });

  it("returns { valid: false } on WebhookNetworkError", async () => {
    const { svc, call } = createService();
    call.mockReturnValue(
      Effect.fail(
        new WebhookNetworkError({
          url: "https://hook.test/users",
          event: "users.validate",
          cause: new Error("ECONNREFUSED"),
        }),
      ),
    );

    expect(await Effect.runPromise(svc.validateUser(UserId(USER_1)))).toEqual({
      valid: false,
    });
  });
});
