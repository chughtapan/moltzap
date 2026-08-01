/** @file Three-container local society using the original simulator. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  AgentRuntimeReady,
  EventCatalog,
  Network,
  ProgramFinished,
  RouterMessageCommitted,
  RouterStarted,
  simulator,
  simulatorLayer,
} from "@moltzap/simulator";
import { openClawRuntime } from "@moltzap/simulator/runtime";
import { NodeRuntime } from "@effect/platform-node";
import {
  Cause,
  Chunk,
  Config,
  Duration,
  Effect,
  Exit,
  Option,
  Schema,
  Stream,
} from "effect";

import imageConfig from "./openclaw-image.json" with { type: "json" };

const ROUTER_LABEL = "moltzap-simulator-run=1";
const LABEL_PREFIX = "com.moltzap.simulator";
const DOCKER_BIN = Effect.runSync(
  Config.string("MOLTZAP_DOCKER_BIN").pipe(
    Config.withDefault("/usr/bin/docker"),
  ),
);
const CONTAINER_LAUNCHER = join(import.meta.dirname, "openclaw-container.mjs");
const LEDGER_DIRECTORY = join(
  import.meta.dirname,
  "../../.tmp/simulator-example/ledgers",
);
const EXPECTED_AGENT_COUNT = 2;
const CLEANUP_ATTEMPTS = 50;
const CLEANUP_POLL = Duration.millis(100);
const MAX_HOLD_SECONDS = 300;
const STRING_COMPARE = (left: string, right: string) =>
  left.localeCompare(right);

class LocalExampleFailed extends Schema.TaggedError<LocalExampleFailed>()(
  "LocalExampleFailed",
  { detail: Schema.NonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}

// Docker's inspect JSON is an external contract whose field names are fixed.
const dockerInspection = Schema.Struct({
  Config: Schema.Struct({
    Env: Schema.Array(Schema.String),
    Image: Schema.String,
    Labels: Schema.Record({ key: Schema.String, value: Schema.String }),
    User: Schema.String,
  }),
  HostConfig: Schema.Struct({
    CapAdd: Schema.NullOr(Schema.Array(Schema.String)),
    CapDrop: Schema.NullOr(Schema.Array(Schema.String)),
    NetworkMode: Schema.String,
    PidMode: Schema.String,
    Privileged: Schema.Boolean,
    ReadonlyRootfs: Schema.Boolean,
    SecurityOpt: Schema.NullOr(Schema.Array(Schema.String)),
  }),
  Id: Schema.String,
  Mounts: Schema.Array(
    Schema.Struct({
      Destination: Schema.String,
      RW: Schema.Boolean,
      Source: Schema.String,
    }),
  ),
  Name: Schema.String,
  State: Schema.Struct({ Running: Schema.Boolean }),
});

const dockerInspections = Schema.parseJson(Schema.Array(dockerInspection));
const dockerSecurityOptions = Schema.parseJson(Schema.Array(Schema.String));
type DockerInspection = typeof dockerInspection.Type;

interface RuntimeMarker {
  readonly agentName: string;
  readonly dockerBin: string;
  readonly runId: string;
}

class CohortDispatchAttempted extends Schema.TaggedClass<CohortDispatchAttempted>()(
  "example.cohort-dispatch-attempted/v1",
  { runId: Schema.NonEmptyString },
) {}

const exampleEvents = EventCatalog.make(CohortDispatchAttempted);
const society = simulator.define("moltzap.local-containers/v1", exampleEvents);

function localFailure(detail: string): LocalExampleFailed {
  return LocalExampleFailed.make({ detail });
}

function runtime(marker: RuntimeMarker) {
  return openClawRuntime({
    installMode: "workspace",
    openclawBin: CONTAINER_LAUNCHER,
    startupTimeout: Duration.minutes(10),
    seedOperatorAuth: false,
    workspaceFiles: [
      {
        relativePath: imageConfig.markerFile,
        content: JSON.stringify(marker),
      },
    ],
    tools: {
      deny: ["*"],
      elevated: { enabled: false },
      exec: { mode: "deny" },
    },
    sandbox: { mode: "off" },
  });
}

function makeRoster(runId: string) {
  return society.agents({
    alice: runtime({ agentName: "alice", dockerBin: DOCKER_BIN, runId }),
    bob: runtime({ agentName: "bob", dockerBin: DOCKER_BIN, runId }),
  });
}

type ExampleRoster = ReturnType<typeof makeRoster>;

interface ExampleProgramResult {
  readonly messageId: string;
  readonly topology: {
    readonly agentContainers: readonly string[];
    readonly routerContainer: string;
  };
}

function dockerOutput(args: readonly string[]) {
  return Effect.async<string, LocalExampleFailed>((resume) => {
    const child = execFile(
      DOCKER_BIN,
      args,
      { encoding: "utf8", maxBuffer: 8 * 1_024 * 1_024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resume(Effect.succeed(stdout.trim()));
          return;
        }
        const detail = stderr.trim() || error.message;
        resume(
          Effect.fail(
            localFailure(`docker ${args[0] ?? "command"}: ${detail}`),
          ),
        );
      },
    );
    return Effect.sync(() => {
      child.kill();
    });
  });
}

function containerIds(label: string) {
  return dockerOutput(["ps", "--quiet", "--filter", `label=${label}`]).pipe(
    Effect.map((output) => (output.length === 0 ? [] : output.split("\n"))),
  );
}

function allContainerIds(label: string) {
  return dockerOutput([
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=${label}`,
  ]).pipe(
    Effect.map((output) => (output.length === 0 ? [] : output.split("\n"))),
  );
}

function inspectContainers(ids: readonly string[]) {
  if (ids.length === 0) {
    return Effect.succeed<readonly DockerInspection[]>([]);
  }
  return dockerOutput(["inspect", ...ids]).pipe(
    Effect.flatMap(Schema.decodeUnknown(dockerInspections)),
    Effect.mapError((cause) =>
      cause instanceof LocalExampleFailed
        ? cause
        : localFailure(`invalid docker inspect output: ${String(cause)}`),
    ),
  );
}

function assertAgentIsolation(
  containers: readonly DockerInspection[],
  runId: string,
): void {
  assert.equal(containers.length, EXPECTED_AGENT_COUNT);
  const names = new Set<string>();
  const writableState = new Set<string>();
  for (const container of containers) {
    names.add(assertAgentIdentity(container, runId));
    assertAgentSecurity(container);
    writableState.add(assertAgentMounts(container));
  }
  assert.deepEqual([...names].sort(STRING_COMPARE), ["alice", "bob"]);
  assert.equal(writableState.size, EXPECTED_AGENT_COUNT);
}

function assertAgentIdentity(
  container: DockerInspection,
  runId: string,
): "alice" | "bob" {
  const labels = container.Config.Labels;
  const agentName = labels[`${LABEL_PREFIX}.agent`];
  assert.ok(agentName === "alice" || agentName === "bob");
  assert.equal(labels[`${LABEL_PREFIX}.run`], runId);
  assert.equal(labels[`${LABEL_PREFIX}.example`], "original-openclaw");
  assert.equal(container.Config.Image, imageConfig.image);
  assert.ok(
    !container.Config.Env.some((value) => value.startsWith("OPENAI_API_KEY=")),
  );
  assert.notEqual(container.Config.User.split(":")[0], "0");
  assert.equal(container.State.Running, true);
  return agentName;
}

function assertAgentSecurity(container: DockerInspection): void {
  assert.equal(container.HostConfig.NetworkMode, "host");
  assert.equal(container.HostConfig.PidMode, "");
  assert.equal(container.HostConfig.Privileged, false);
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(container.HostConfig.CapAdd, null);
  assert.ok(container.HostConfig.CapDrop?.includes("ALL"));
  assert.ok(
    container.HostConfig.SecurityOpt?.some((value) =>
      value.startsWith("no-new-privileges"),
    ),
  );
}

function assertAgentMounts(container: DockerInspection): string {
  assert.ok(
    container.Mounts.every(
      (mount) =>
        !mount.Source.endsWith("docker.sock") &&
        !mount.Destination.endsWith("docker.sock"),
    ),
  );
  const writable = container.Mounts.filter((mount) => mount.RW);
  assert.equal(writable.length, 1);
  const state = writable[0];
  assert.ok(state);
  assert.equal(state.Source, state.Destination);
  assert.ok(
    container.Mounts.filter((mount) => !mount.RW).length >= 4,
    `${container.Name} is missing read-only runtime mounts`,
  );
  return state.Source;
}

function routerContainerId(routerUrl: string) {
  const port = URL.canParse(routerUrl) ? new URL(routerUrl).port : "";
  if (port.length === 0) {
    return Effect.fail(
      localFailure(`router URL has no published port: ${routerUrl}`),
    );
  }
  return dockerOutput([
    "ps",
    "--quiet",
    "--filter",
    `label=${ROUTER_LABEL}`,
    "--filter",
    `publish=${port}`,
  ]).pipe(
    Effect.map((output) => (output.length === 0 ? [] : output.split("\n"))),
    Effect.flatMap((ids) =>
      ids.length === 1 && ids[0] !== undefined
        ? Effect.succeed(ids[0])
        : Effect.fail(
            localFailure(
              `router URL ${routerUrl} matched ${String(ids.length)} containers`,
            ),
          ),
    ),
  );
}

function observeTopology(runId: string, routerUrl: string) {
  return Effect.gen(function* () {
    const agentIds = yield* containerIds(`${LABEL_PREFIX}.run=${runId}`);
    const agents = yield* inspectContainers(agentIds);
    yield* Effect.sync(() => {
      assertAgentIsolation(agents, runId);
    });

    const routerContainer = yield* routerContainerId(routerUrl);
    return {
      agentContainers: agents
        .map((container) => container.Name.slice(1))
        .sort(STRING_COMPARE),
      routerContainer,
    };
  });
}

const holdDuration = Config.integer("MOLTZAP_SIM_HOLD_SECONDS").pipe(
  Config.withDefault(0),
  Effect.filterOrFail(
    (seconds) => seconds >= 0 && seconds <= MAX_HOLD_SECONDS,
    () =>
      localFailure(
        `MOLTZAP_SIM_HOLD_SECONDS must be an integer from 0 to ${String(MAX_HOLD_SECONDS)}`,
      ),
  ),
  Effect.map(Duration.seconds),
);

function assertEventOrder(records: ReadonlyArray<{ readonly event: unknown }>) {
  const tags = records.map((record) => {
    const event = record.event;
    return typeof event === "object" && event !== null && "_tag" in event
      ? event._tag
      : undefined;
  });
  const router = tags.indexOf(RouterStarted._tag);
  const readiness = tags.flatMap((tag, index) =>
    tag === AgentRuntimeReady._tag ? [index] : [],
  );
  const dispatch = tags.indexOf(CohortDispatchAttempted._tag);
  const message = tags.indexOf(RouterMessageCommitted._tag);
  assert.ok(router >= 0);
  assert.equal(readiness.length, EXPECTED_AGENT_COUNT);
  assert.ok(readiness.every((index) => router < index));
  assert.ok(readiness.every((index) => index < dispatch));
  assert.ok(dispatch < message);
  return tags.filter((tag): tag is string => typeof tag === "string");
}

function waitForCleanup(runId: string, routerContainer: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      const agents = yield* allContainerIds(`${LABEL_PREFIX}.run=${runId}`);
      const router = yield* dockerOutput([
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `id=${routerContainer}`,
      ]);
      if (agents.length === 0 && router.length === 0) {
        return;
      }
      yield* Effect.sleep(CLEANUP_POLL);
    }
    return yield* Effect.fail(
      localFailure(`run ${runId} left a router or agent container behind`),
    );
  });
}

const assertLinuxHost = Effect.succeed(process.platform).pipe(
  Effect.filterOrFail(
    (platform) => platform === "linux",
    (platform) =>
      localFailure(
        `the local profile requires a Linux host, found ${platform}`,
      ),
  ),
  Effect.asVoid,
);

const assertDockerPlatform = dockerOutput([
  "info",
  "--format",
  "{{.OSType}}/{{.Architecture}}",
]).pipe(
  Effect.filterOrFail(
    (platform) => platform === "linux/x86_64" || platform === "linux/amd64",
    (platform) =>
      localFailure(
        `the local profile requires Linux/amd64 Docker, found ${platform}`,
      ),
  ),
  Effect.asVoid,
);

const dockerSecurity = dockerOutput([
  "info",
  "--format",
  "{{json .SecurityOptions}}",
]).pipe(
  Effect.flatMap(Schema.decodeUnknown(dockerSecurityOptions)),
  Effect.mapError((cause) =>
    cause instanceof LocalExampleFailed
      ? cause
      : localFailure(`invalid Docker security options: ${String(cause)}`),
  ),
);

const assertDockerSecurity = dockerSecurity.pipe(
  Effect.filterOrFail(
    (securityOptions) =>
      !securityOptions.some(
        (option) =>
          option.startsWith("name=rootless") ||
          option.startsWith("name=userns"),
      ),
    () =>
      localFailure(
        "the local profile requires rootful Docker without user namespace remapping",
      ),
  ),
  Effect.asVoid,
);

const assertHostUser = Effect.sync(() => ({
  gid: process.getgid?.(),
  uid: process.getuid?.(),
})).pipe(
  Effect.filterOrFail(
    ({ gid, uid }) =>
      uid !== undefined && gid !== undefined && uid !== 0 && gid !== 0,
    () => localFailure("the local profile requires a non-root host user"),
  ),
  Effect.asVoid,
);

const assertLocalDocker = Effect.all(
  [assertLinuxHost, assertDockerPlatform, assertDockerSecurity, assertHostUser],
  { concurrency: 1, discard: true },
);

function printJson(value: unknown) {
  return Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  });
}

function exampleProgram(
  runId: string,
  roster: ExampleRoster,
  pause: Duration.Duration,
) {
  return Effect.gen(function* () {
    const agents = yield* roster.startedAgents;
    const network = yield* Network;
    const events = yield* society.events;
    const ledger = yield* society.ledger;
    const routerStarted = yield* ledger
      .events(RouterStarted)
      .pipe(Stream.runHead);
    if (Option.isNone(routerStarted)) {
      return yield* Effect.fail(
        localFailure("the run ledger has no router-started event"),
      );
    }
    const topology = yield* observeTopology(
      runId,
      routerStarted.value.routerUrl,
    );
    yield* printJson({
      phase: "ready",
      runId,
      containers: {
        router: topology.routerContainer,
        agents: topology.agentContainers,
      },
      agentIds: {
        alice: agents.alice.agent.id,
        bob: agents.bob.agent.id,
      },
    });
    yield* Effect.sleep(pause);
    yield* events.emit(CohortDispatchAttempted.make({ runId }));
    const diagnostic = yield* network.endpoint("diagnostic");
    const conversation = yield* diagnostic.open(
      agents.alice.agent,
      agents.bob.agent,
    );
    const message = yield* conversation.send(
      "The local container cohort passed its channel diagnostic; no model response is required.",
    );
    return { messageId: message.id, topology };
  });
}

function collectCompletion(
  outcome: ProgramFinished<ExampleProgramResult, unknown>,
) {
  return Effect.gen(function* () {
    if (Exit.isFailure(outcome.exit)) {
      return yield* Effect.die(
        localFailure(
          `simulator program failed: ${Cause.pretty(outcome.exit.cause)}`,
        ),
      );
    }
    const ledger = yield* society.openLedger(outcome.receipt.ledger);
    const records = yield* Stream.runCollect(ledger.records);
    const eventOrder = yield* Effect.sync(() =>
      assertEventOrder(Chunk.toReadonlyArray(records)),
    );
    return {
      eventOrder,
      ledger: outcome.receipt.ledger,
      messageId: outcome.exit.value.messageId,
      topology: outcome.exit.value.topology,
    };
  });
}

const hostLayer = simulatorLayer({
  ledgerDirectory: LEDGER_DIRECTORY,
  router: { startupTimeout: Duration.minutes(10) },
});

const main = Effect.gen(function* () {
  yield* assertLocalDocker;
  const runId = randomUUID();
  const pause = yield* holdDuration;
  const roster = makeRoster(runId);
  const outcome = yield* society.run(
    roster,
    exampleProgram(runId, roster, pause),
    {
      provenance: {
        execution: "local-linux-containers",
        openclawImage: imageConfig.image,
        runId,
      },
    },
  );
  if (!(outcome instanceof ProgramFinished)) {
    return yield* Effect.die(
      localFailure(
        `simulator infrastructure failed: ${Cause.pretty(outcome.cause)}`,
      ),
    );
  }
  const completed = yield* collectCompletion(outcome);
  yield* waitForCleanup(runId, completed.topology.routerContainer);
  yield* printJson({
    phase: "completed",
    runId,
    image: imageConfig.image,
    ...completed,
    cleanup: "no run-owned containers remain",
  });
}).pipe(Effect.provide(hostLayer));

NodeRuntime.runMain(main);
