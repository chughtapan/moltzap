import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand } from "./register.js";

type RegisterResult = {
  agentId: string;
  apiKey: string;
  claimUrl: string;
};
const mockRegisterAgent =
  vi.fn<
    (
      name: string,
      inviteCode: string,
      description?: string,
    ) => Effect.Effect<RegisterResult, Error>
  >();

vi.mock("../http-client.js", () => ({
  registerAgent: (name: string, inviteCode: string, description?: string) =>
    mockRegisterAgent(name, inviteCode, description),
}));

vi.mock("../config.js", () => ({
  updateConfig: vi.fn(() => Effect.void),
  getServerUrl: Effect.succeed("wss://test"),
}));

// Avoid real fs writes — register calls writeOpenClawChannelConfig which
// uses node:fs directly. Mock the whole module surface.
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe("register command handler", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exit = vi.fn() as never;
    mockRegisterAgent.mockImplementation(() =>
      Effect.succeed({
        agentId: "agent-123",
        apiKey: "moltzap_agent_testkey",
        claimUrl: "https://moltzap.xyz/claim/tok_abc",
      }),
    );
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("passes name, inviteCode, and description through", async () => {
    await Effect.runPromise(
      registerCommand.handler({
        name: "my-agent",
        inviteCode: "inv_abc123",
        description: Option.none(),
        profile: Option.none(),
        noPersist: false,
      }),
    );
    expect(mockRegisterAgent).toHaveBeenCalledWith(
      "my-agent",
      "inv_abc123",
      undefined,
    );
  });

  it("forwards description option when provided", async () => {
    await Effect.runPromise(
      registerCommand.handler({
        name: "my-agent",
        inviteCode: "inv_abc123",
        description: Option.some("A test agent"),
        profile: Option.none(),
        noPersist: false,
      }),
    );
    expect(mockRegisterAgent).toHaveBeenCalledWith(
      "my-agent",
      "inv_abc123",
      "A test agent",
    );
  });

  it("exits with error on registration failure", async () => {
    mockRegisterAgent.mockImplementationOnce(() =>
      Effect.fail(new Error("Invalid invite code")),
    );
    await Effect.runPromise(
      registerCommand.handler({
        name: "my-agent",
        inviteCode: "inv_bad",
        description: Option.none(),
        profile: Option.none(),
        noPersist: false,
      }),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
