import { Data, Effect, Option } from "effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { registerCommand } from "./register.js";

const it = effectIt.effect;
const AGENT_NAME = "my-agent";
const INVITE_CODE = "inv_abc123";
const BAD_INVITE_CODE = "inv_bad";
const DESCRIPTION = "A test agent";
const AGENT_ID = "agent-123";
const API_KEY = "moltzap_agent_testkey";
const CLAIM_URL = "https://moltzap.xyz/claim/tok_abc";

type RegisterResult = {
  agentId: string;
  apiKey: string;
  claimUrl: string;
};

class RegisterTestFailure extends Data.TaggedError("RegisterTestFailure")<{
  readonly message: string;
}> {}

const mockRegisterAgent =
  vi.fn<
    (
      name: string,
      inviteCode: string,
      description?: string,
    ) => Effect.Effect<RegisterResult, RegisterTestFailure>
  >();

vi.mock("../http-client.js", () => ({
  registerAgent: (name: string, inviteCode: string, description?: string) => {
    const resolvedDescription = description;
    return mockRegisterAgent(name, inviteCode, resolvedDescription);
  },
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

function registerHandlerInput(description: Option.Option<string>) {
  return {
    name: AGENT_NAME,
    inviteCode: INVITE_CODE,
    description,
    profile: Option.none<string>(),
    noPersist: false,
  };
}

function successfulRegistration() {
  return Effect.succeed({
    agentId: AGENT_ID,
    apiKey: API_KEY,
    claimUrl: CLAIM_URL,
  });
}

function failedRegistration() {
  return Effect.fail(
    new RegisterTestFailure({ message: "Invalid invite code" }),
  );
}

function passThroughWithoutDescription() {
  return Effect.gen(function* () {
    yield* registerCommand.handler(registerHandlerInput(Option.none()));
    expect(mockRegisterAgent).toHaveBeenCalledWith(
      AGENT_NAME,
      INVITE_CODE,
      undefined,
    );
  });
}

function forwardsDescription() {
  return Effect.gen(function* () {
    yield* registerCommand.handler(
      registerHandlerInput(Option.some(DESCRIPTION)),
    );
    expect(mockRegisterAgent).toHaveBeenCalledWith(
      AGENT_NAME,
      INVITE_CODE,
      DESCRIPTION,
    );
  });
}

function exitsOnRegistrationFailure() {
  return Effect.gen(function* () {
    mockRegisterAgent.mockImplementationOnce(failedRegistration);
    yield* registerCommand.handler({
      ...registerHandlerInput(Option.none()),
      inviteCode: BAD_INVITE_CODE,
      description: Option.none(),
    });
    expect(process.exit).toHaveBeenCalledWith(1);
  });
}

describe("register command handler", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exit = vi.fn() as never;
    mockRegisterAgent.mockImplementation(successfulRegistration);
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it(
    "passes name, inviteCode, and description through",
    passThroughWithoutDescription,
  );

  it("forwards description option when provided", forwardsDescription);

  it("exits with error on registration failure", exitsOnRegistrationFailure);
});
