import { Data, Effect, Option } from "effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { registerCommand } from "./register.js";
import type { AgentKey } from "@moltzap/protocol/identity";
import { agentKeyString, redactedAgentKey } from "@moltzap/protocol/testing";
import { parseProfileName, type ProfileName } from "../../profile.js";

const it = effectIt.effect;
const AGENT_NAME = Effect.runSync(parseProfileName("my-agent"));
const INVITE_CODE = "inv_abc123";
const BAD_INVITE_CODE = "inv_bad";
const DESCRIPTION = "A test agent";
const AGENT_ID = "00000000-0000-4000-8000-000000000123";
const API_KEY = redactedAgentKey(agentKeyString(10));

interface RegisterResult {
  agentId: string;
  apiKey: AgentKey;
}

class RegisterTestFailure extends Data.TaggedError("RegisterTestFailure")<{
  readonly message: string;
}> {}

const mockRegisterAgent =
  vi.fn<
    (
      baseUrl: string,
      name: string,
      opts?: { readonly inviteCode?: string; readonly description?: string },
    ) => Effect.Effect<RegisterResult, RegisterTestFailure>
  >();

vi.mock("../../auth.js", () => ({
  registerAgent: (
    baseUrl: string,
    name: string,
    opts?: { readonly inviteCode?: string; readonly description?: string },
  ) => {
    if (opts === undefined) {
      return mockRegisterAgent(baseUrl, name);
    }
    return mockRegisterAgent(baseUrl, name, opts);
  },
}));

vi.mock("../../config.js", () => ({
  getHttpUrl: Effect.succeed("https://test"),
  getServerUrl: Effect.succeed("wss://test"),
}));

function registerHandlerInput(description: Option.Option<string>) {
  return {
    name: AGENT_NAME,
    inviteCode: INVITE_CODE,
    description,
    profile: Option.none<ProfileName>(),
    noPersist: true,
  };
}

function successfulRegistration() {
  return Effect.succeed({
    agentId: AGENT_ID,
    apiKey: API_KEY,
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
    expect(mockRegisterAgent).toHaveBeenCalledWith("https://test", AGENT_NAME, {
      inviteCode: INVITE_CODE,
    });
  });
}

function forwardsDescription() {
  return Effect.gen(function* () {
    yield* registerCommand.handler(
      registerHandlerInput(Option.some(DESCRIPTION)),
    );
    expect(mockRegisterAgent).toHaveBeenCalledWith("https://test", AGENT_NAME, {
      inviteCode: INVITE_CODE,
      description: DESCRIPTION,
    });
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
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest deliberately inspects the installed process.exit mock without invoking it.
    expect(process.exit).toHaveBeenCalledWith(1);
  });
}

describe("register command handler", () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The test snapshots process.exit solely to restore the original method.
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exit =
      /* Safe because the test fixture establishes this asserted shape. */ vi.fn() as never;
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
