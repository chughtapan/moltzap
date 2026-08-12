import { live as it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { acquireMoltzapdChild } from "../../../moltzapd-child.js";
import { withTestServiceConfig } from "../../../config.test-utils.js";
import { parseProfileName, writeProfile } from "../../../profile.js";
import { reserveTestMcpPort } from "../../../test-utils/process/reserve-port.js";
import * as H from "../../support/index.js";

const FIRST_PROFILE = "shared-port-first";
const SECOND_PROFILE = "shared-port-second";
const OUTPUT_PROFILE = "bounded-output";
const NODE_OPTIONS_ENV = "NODE_OPTIONS";
const OUTPUT_BEGIN = "[moltzapd-output-begin]";
const OUTPUT_END = "[moltzapd-output-end]";
const OUTPUT_TRUNCATED_NOTICE = "[earlier moltzapd output truncated]\n";
const OUTPUT_TAIL_LIMIT = 64 * 1024;
const MAX_LOG_LENGTH = OUTPUT_TRUNCATED_NOTICE.length + OUTPUT_TAIL_LIMIT;
const outputPreload = fileURLToPath(
  new URL("./moltzapd-output-preload.cjs", import.meta.url),
);
const earlyReadyPreload = fileURLToPath(
  new URL("./moltzapd-early-ready-preload.cjs", import.meta.url),
);

type RegisteredAgent = Effect.Effect.Success<
  ReturnType<typeof H.registerAgent>
>;

const closeAgent = (agent: RegisteredAgent): Effect.Effect<void> =>
  agent.client.close().pipe(Effect.ignore);

const closeAgents = (agents: readonly RegisteredAgent[]): Effect.Effect<void> =>
  Effect.forEach(agents, closeAgent, { concurrency: agents.length }).pipe(
    Effect.asVoid,
  );

const restoreEnv = (key: string, previous?: string): void => {
  if (previous === undefined) {
    // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- This test restores the environment inherited by its scoped child process.
    Reflect.deleteProperty(process.env, key);
    return;
  }
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- This test restores the environment inherited by its scoped child process.
  process.env[key] = previous;
};

const withNodeOptions = <A, E, R>(
  options: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- The daemon child inherits this test-scoped preload option.
      const previous = process.env[NODE_OPTIONS_ENV];
      // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- The daemon child inherits this test-scoped preload option.
      process.env[NODE_OPTIONS_ENV] = options;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        restoreEnv(NODE_OPTIONS_ENV, previous);
      }),
  );

const profileConfig = (
  profileName: string,
  agent: RegisteredAgent,
  mcpPort: number,
) => ({
  profileName,
  agentName: profileName,
  agentId: agent.agentId,
  agentKey: agent.apiKey,
  serverUrl: H.coreBaseUrl(),
  mcpPort,
});

const addProfile = (
  profileName: string,
  agent: RegisteredAgent,
  mcpPort: number,
) =>
  parseProfileName(profileName).pipe(
    Effect.flatMap((name) =>
      writeProfile(name, {
        agentName: profileName,
        mcpPort,
        agentId: agent.agentId,
        apiKey: agent.apiKey,
      }),
    ),
  );

const acquireFirstAgainstSecond = (agent: RegisteredAgent, mcpPort: number) =>
  withTestServiceConfig(
    profileConfig(SECOND_PROFILE, agent, mcpPort),
    addProfile(FIRST_PROFILE, agent, mcpPort).pipe(
      Effect.zipRight(
        Effect.scoped(
          acquireMoltzapdChild({ profileName: SECOND_PROFILE }).pipe(
            Effect.zipRight(
              Effect.scoped(
                acquireMoltzapdChild({ profileName: FIRST_PROFILE }),
              ).pipe(Effect.exit),
            ),
          ),
        ),
      ),
    ),
  );

const assertAcquisitionFailed = (
  firstExit: Exit.Exit<unknown, unknown>,
): void => {
  expect(Exit.isFailure(firstExit)).toBe(true);
};

const runSharedPortCollision = (
  agent: RegisteredAgent,
): Effect.Effect<void, unknown> =>
  Effect.scoped(reserveTestMcpPort).pipe(
    Effect.flatMap((mcpPort) => acquireFirstAgainstSecond(agent, mcpPort)),
    Effect.map(assertAcquisitionFailed),
  );

const acquireMismatchedEndpoint = (
  expected: RegisteredAgent,
  actual: RegisteredAgent,
  mcpPort: number,
) =>
  withTestServiceConfig(
    profileConfig(SECOND_PROFILE, actual, mcpPort),
    addProfile(FIRST_PROFILE, expected, mcpPort).pipe(
      Effect.zipRight(
        Effect.scoped(
          acquireMoltzapdChild({ profileName: SECOND_PROFILE }).pipe(
            Effect.zipRight(
              withNodeOptions(
                `--require=${earlyReadyPreload}`,
                Effect.scoped(
                  acquireMoltzapdChild({ profileName: FIRST_PROFILE }),
                ),
              ).pipe(Effect.exit),
            ),
          ),
        ),
      ),
    ),
  );

const assertIdentityMismatch = (
  acquisition: Exit.Exit<unknown, unknown>,
  expected: RegisteredAgent,
  actual: RegisteredAgent,
): void => {
  expect(Exit.isFailure(acquisition)).toBe(true);
  if (Exit.isFailure(acquisition)) {
    const squashed = Cause.squash(acquisition.cause);
    const message = squashed instanceof Error ? squashed.message : "";
    expect(message).toContain(FIRST_PROFILE);
    expect(message).toContain(expected.agentId);
    expect(message).toContain(actual.agentId);
  }
};

const runIdentityMismatch = (
  agents: readonly [RegisteredAgent, RegisteredAgent],
): Effect.Effect<void, unknown> =>
  Effect.scoped(reserveTestMcpPort).pipe(
    Effect.flatMap((mcpPort) =>
      acquireMismatchedEndpoint(agents[0], agents[1], mcpPort),
    ),
    Effect.map((acquisition) => {
      assertIdentityMismatch(acquisition, agents[0], agents[1]);
      return undefined;
    }),
  );

const assertBoundedOutput = (output: string): void => {
  expect(output).toContain(OUTPUT_TRUNCATED_NOTICE);
  expect(output).not.toContain(OUTPUT_BEGIN);
  expect(output).toContain(OUTPUT_END);
  expect(output.length).toBeLessThanOrEqual(MAX_LOG_LENGTH);
};

const runBoundedOutput = (
  agent: RegisteredAgent,
): Effect.Effect<void, unknown> =>
  Effect.scoped(reserveTestMcpPort).pipe(
    Effect.flatMap((mcpPort) =>
      withTestServiceConfig(
        profileConfig(OUTPUT_PROFILE, agent, mcpPort),
        withNodeOptions(
          `--require=${outputPreload}`,
          Effect.scoped(
            acquireMoltzapdChild({ profileName: OUTPUT_PROFILE }).pipe(
              Effect.map((child) => child.logs()),
            ),
          ),
        ),
      ),
    ),
    Effect.map(assertBoundedOutput),
  );

H.setupServiceIntegration();

it("does not attach to another daemon with the same AgentId on a shared port", () => {
  expect.hasAssertions();
  return Effect.acquireUseRelease(
    H.registerAgent("shared-port-agent"),
    runSharedPortCollision,
    closeAgent,
  );
});

it("retains only a bounded tail of long-lived child output", () => {
  expect.hasAssertions();
  return Effect.acquireUseRelease(
    H.registerAgent("bounded-output-agent"),
    runBoundedOutput,
    closeAgent,
  );
});

it("rejects a ready endpoint that reports another profile's AgentId", () => {
  expect.hasAssertions();
  return Effect.acquireUseRelease(
    Effect.all([
      H.registerAgent("identity-expected-agent"),
      H.registerAgent("identity-actual-agent"),
    ]),
    runIdentityMismatch,
    closeAgents,
  );
});
