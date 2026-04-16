import { describe, it, expect, vi } from "vitest";
import { InProcessUserService, WebhookUserService } from "./user.service.js";
import { WebhookClient, WebhookError } from "../adapters/webhook.js";

describe("InProcessUserService", () => {
  it("always returns { valid: true }", async () => {
    const svc = new InProcessUserService();
    expect(await svc.validateUser("any-user")).toEqual({ valid: true });
    expect(await svc.validateUser("")).toEqual({ valid: true });
  });
});

describe("WebhookUserService", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;

  function createService() {
    const client = new WebhookClient();
    const callSync = vi.spyOn(client, "callSync");
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

    const result = await svc.validateUser("user-42");

    expect(result).toEqual({ valid: true });
    expect(callSync).toHaveBeenCalledWith({
      url: "https://hook.test/users",
      event: "users.validate",
      body: { userId: "user-42" },
      timeoutMs: 5000,
    });
  });

  it("returns { valid: false } when webhook returns it", async () => {
    const { svc, callSync } = createService();
    callSync.mockResolvedValue({ valid: false });

    expect(await svc.validateUser("bad-user")).toEqual({ valid: false });
  });

  it("returns { valid: false } on WebhookError", async () => {
    const { svc, callSync } = createService();
    callSync.mockRejectedValue(new WebhookError("timeout", 0));

    expect(await svc.validateUser("user-1")).toEqual({ valid: false });
  });

  it("returns { valid: false } on network error", async () => {
    const { svc, callSync } = createService();
    callSync.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await svc.validateUser("user-1")).toEqual({ valid: false });
  });
});
