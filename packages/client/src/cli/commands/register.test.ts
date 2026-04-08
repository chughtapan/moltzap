import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerCommand } from "./register.js";

const mockRegisterAgent = vi.fn().mockResolvedValue({
  agentId: "agent-123",
  apiKey: "moltzap_agent_testkey",
  claimUrl: "https://moltzap.xyz/claim/tok_abc",
});

vi.mock("../http-client.js", () => ({
  registerAgent: (...args: unknown[]) => mockRegisterAgent(...args),
}));

vi.mock("../config.js", () => ({
  updateConfig: vi.fn(),
}));

describe("register command", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("parses: register <name> <invite-code>", async () => {
    await registerCommand.parseAsync([
      "node",
      "test",
      "my-agent",
      "inv_abc123",
    ]);

    expect(mockRegisterAgent).toHaveBeenCalledWith(
      "my-agent",
      "inv_abc123",
      undefined,
    );
  });

  it("parses: register <name> <invite-code> -d <description>", async () => {
    await registerCommand.parseAsync([
      "node",
      "test",
      "my-agent",
      "inv_abc123",
      "-d",
      "A test agent",
    ]);

    expect(mockRegisterAgent).toHaveBeenCalledWith(
      "my-agent",
      "inv_abc123",
      "A test agent",
    );
  });

  it("exits with error on registration failure", async () => {
    mockRegisterAgent.mockRejectedValueOnce(new Error("Invalid invite code"));

    await registerCommand.parseAsync(["node", "test", "my-agent", "inv_bad"]);

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
