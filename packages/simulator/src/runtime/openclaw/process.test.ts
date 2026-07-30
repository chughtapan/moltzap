import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandExecutor } from "@effect/platform";
import { NodeContext, NodeSocketServer } from "@effect/platform-node";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  Redacted,
} from "effect";
import { serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { OpenClawSchema } from "openclaw/plugin-sdk/config-schema";
import { isToolAllowed } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it } from "vitest";
import {
  acquireOpenClawProcess,
  buildOpenClawConfig,
  buildOpenClawProcessPlan,
  leaseOpenClawPort,
  type OpenClawProcessInput,
  type OpenClawSandboxConfig,
  type OpenClawToolsConfig,
} from "./process.js";

const EPHEMERAL_PORT = 0;
const PORT_LEASE_CONCURRENCY = 64;
const ACQUISITION_INTERRUPT_TIMEOUT_MS = 1_000;
const PROCESS_PORT = 44_321;
const STATE_DIR = "/run/moltzap/openclaw/alice";
const OPERATOR_HOME = "/home/operator";
const CHANNEL_DIST_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../openclaw-channel/dist",
);
const PROCESS_INPUT: OpenClawProcessInput = {
  agentName: "alice",
  agentId: agentId("00000000-0000-4000-8000-000000000001"),
  apiKey: redactedAgentKey(agentKeyString(97)),
  serverUrl: serverBaseUrl("http://127.0.0.1:43123"),
};
const FAIL_CLOSED_TOOLS = {
  deny: ["*"],
  elevated: { enabled: false },
  exec: { mode: "deny" },
} satisfies OpenClawToolsConfig;
const MESSAGE_ONLY_TOOLS = {
  allow: ["message"],
  elevated: { enabled: false },
  exec: { mode: "deny" },
} satisfies OpenClawToolsConfig;
const FAIL_CLOSED_SANDBOX = {
  mode: "all",
  backend: "docker",
  scope: "session",
  workspaceAccess: "none",
  docker: { network: "none" },
} satisfies OpenClawSandboxConfig;

function rendersFailClosedPolicy(): void {
  const config = buildOpenClawConfig(
    {
      agentName: PROCESS_INPUT.agentName,
      installMode: "workspace",
      tools: FAIL_CLOSED_TOOLS,
      sandbox: FAIL_CLOSED_SANDBOX,
      gatewayToken: Redacted.make("test-gateway-token"),
    },
    join(STATE_DIR, "workspace"),
  );

  expect(OpenClawSchema.safeParse(config).success).toBe(true);
  expect(config.tools).toEqual(FAIL_CLOSED_TOOLS);
  expect(config.agents?.defaults?.sandbox).toEqual(FAIL_CLOSED_SANDBOX);
  for (const tool of [
    "exec",
    "read",
    "web_fetch",
    "session_status",
    "moltzap_custom",
  ]) {
    expect(isToolAllowed(config.tools ?? {}, tool)).toBe(false);
  }
}

function preservesOmittedPolicy(): void {
  const config = buildOpenClawConfig(
    {
      agentName: PROCESS_INPUT.agentName,
      installMode: "workspace",
      gatewayToken: Redacted.make("test-gateway-token"),
    },
    join(STATE_DIR, "workspace"),
  );

  expect(config).not.toHaveProperty("tools");
  expect(config.agents?.defaults).not.toHaveProperty("sandbox");
}

function allowsOnlyNativeMessageTool(): void {
  const config = buildOpenClawConfig(
    {
      agentName: PROCESS_INPUT.agentName,
      installMode: "workspace",
      tools: MESSAGE_ONLY_TOOLS,
      gatewayToken: Redacted.make("test-gateway-token"),
    },
    join(STATE_DIR, "workspace"),
  );

  expect(isToolAllowed(config.tools ?? {}, "message")).toBe(true);
  for (const tool of ["exec", "read", "web_fetch", "moltzap_custom"]) {
    expect(isToolAllowed(config.tools ?? {}, tool)).toBe(false);
  }
}

function usesIsolatedStateDirectory(): void {
  const plan = buildOpenClawProcessPlan({
    openclawBin: "openclaw",
    port: PROCESS_PORT,
    stateDir: STATE_DIR,
    input: PROCESS_INPUT,
    baseEnvironment: {
      PATH: "/usr/bin",
      HOME: OPERATOR_HOME,
    },
  });

  expect(plan.cwd).toBe(STATE_DIR);
  expect(plan.env.HOME).toBe(STATE_DIR);
  expect(plan.env.HOME).not.toBe(OPERATOR_HOME);
  expect(plan.env.OPENCLAW_CONFIG_PATH).toBe(join(STATE_DIR, "openclaw.json"));
}

describe("OpenClaw generated policy", () => {
  it(
    "renders a native fail-closed tool and sandbox policy",
    rendersFailClosedPolicy,
  );
  it("allows only the native social message tool", allowsOnlyNativeMessageTool);
  it("preserves omitted customer policy", preservesOmittedPolicy);
  it(
    "uses the isolated state directory as the child HOME",
    usesIsolatedStateDirectory,
  );
});

describe("OpenClaw port claims", () => {
  it(
    "leases unique logical ports after every probe has closed",
    openClawPortLeasesRemainUniqueAfterProbeClose,
  );

  it(
    "does not reissue a transferred logical claim",
    openClawPortClaimSurvivesProbeClose,
  );

  it(
    "releases an untransferred claim with its startup scope",
    openClawStartupScopeReleasesPortClaim,
  );

  it(
    "finishes probe teardown when concurrent startup is interrupted",
    interruptedOpenClawPortProbesFinish,
  );

  it(
    "interrupts process acquisition while startup is pending",
    interruptedOpenClawProcessAcquisitionFinishes,
  );
});

function openClawPortLeasesRemainUniqueAfterProbeClose() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const claims = yield* Effect.all(
          Array.from({ length: PORT_LEASE_CONCURRENCY }, () =>
            leaseOpenClawPort(),
          ),
          { concurrency: PORT_LEASE_CONCURRENCY },
        );
        const ports = claims.map((claim) => claim.port);
        expect(new Set(ports).size).toBe(PORT_LEASE_CONCURRENCY);

        const competingBinds = yield* Effect.all(
          ports.map((port) =>
            Effect.scoped(
              NodeSocketServer.make({ host: "127.0.0.1", port }),
            ).pipe(Effect.either),
          ),
          { concurrency: PORT_LEASE_CONCURRENCY },
        );
        expect(competingBinds.every(Either.isRight)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeContext.layer), Effect.orDie),
  );
}

function openClawPortClaimSurvivesProbeClose() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const claim = yield* leaseTransferredClaim();
      yield* expectOpenClawPortClaimed(claim.port).pipe(
        Effect.ensuring(claim.release()),
      );
    }).pipe(Effect.orDie),
  );
}

function openClawStartupScopeReleasesPortClaim() {
  return Effect.runPromise(
    Effect.gen(function* () {
      let port = EPHEMERAL_PORT;
      yield* Effect.scoped(
        leaseOpenClawPort().pipe(
          Effect.tap((claim) =>
            Effect.sync(() => {
              port = claim.port;
            }),
          ),
        ),
      );
      yield* expectOpenClawPortReleased(port);
    }).pipe(Effect.orDie),
  );
}

function interruptedOpenClawPortProbesFinish() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const acquisitions = yield* Effect.all(
          Array.from({ length: PORT_LEASE_CONCURRENCY }, () =>
            leaseOpenClawPort().pipe(Effect.fork),
          ),
          { concurrency: PORT_LEASE_CONCURRENCY },
        );
        yield* Effect.yieldNow();
        yield* Effect.forEach(acquisitions, Fiber.interrupt, {
          concurrency: PORT_LEASE_CONCURRENCY,
          discard: true,
        });
      }),
    ).pipe(Effect.provide(NodeContext.layer), Effect.orDie),
  );
}

function interruptedOpenClawProcessAcquisitionFinishes() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const commandStarted = yield* Deferred.make<undefined>();
        const stalledCommandExecutor = CommandExecutor.makeExecutor(() =>
          Deferred.succeed(commandStarted, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
        );
        const acquisition = yield* acquireOpenClawProcess(
          {
            openclawBin: "unused",
            channelDistDir: CHANNEL_DIST_DIR,
            installMode: "workspace",
          },
          PROCESS_INPUT,
        ).pipe(
          Effect.provideService(
            CommandExecutor.CommandExecutor,
            stalledCommandExecutor,
          ),
          Effect.forkDaemon,
        );

        yield* Deferred.await(commandStarted);
        yield* Fiber.interruptFork(acquisition);
        const exit = yield* Fiber.await(acquisition).pipe(
          Effect.timeout(Duration.millis(ACQUISITION_INTERRUPT_TIMEOUT_MS)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
        }
      }),
    ).pipe(Effect.provide(NodeContext.layer), Effect.orDie),
  );
}

function expectOpenClawPortClaimed(port: number) {
  return observeOpenClawPortCandidates([port, EPHEMERAL_PORT]).pipe(
    Effect.tap(({ allocatedPort, requested }) =>
      Effect.sync(() => {
        expect(requested.slice(0, 2)).toEqual([port, EPHEMERAL_PORT]);
        expect(allocatedPort).not.toBe(port);
      }),
    ),
    Effect.asVoid,
  );
}

function expectOpenClawPortReleased(port: number) {
  return observeOpenClawPortCandidates([port, EPHEMERAL_PORT]).pipe(
    Effect.tap(({ allocatedPort, requested }) =>
      Effect.sync(() => {
        expect(requested).toEqual([port]);
        expect(allocatedPort).toBe(port);
      }),
    ),
    Effect.asVoid,
  );
}

function observeOpenClawPortCandidates(candidatePorts: readonly number[]) {
  const candidates = [...candidatePorts];
  const requested: number[] = [];
  return Effect.scoped(
    leaseOpenClawPort({
      candidatePort: () => {
        const candidate = candidates.shift() ?? EPHEMERAL_PORT;
        requested.push(candidate);
        return candidate;
      },
    }).pipe(
      Effect.map((claim) => ({
        allocatedPort: claim.port,
        requested,
      })),
    ),
  );
}

function leaseTransferredClaim() {
  return Effect.scoped(
    leaseOpenClawPort().pipe(Effect.tap((claim) => claim.transfer())),
  );
}
