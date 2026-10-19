/** @file Published peers and the current daemon certify posts in both directions. */

import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { acquireHarnessEndpoint, AgentAddress } from "@moltzap/client";
import { Data, Effect, Fiber, Option, Schedule, Schema, Stream } from "effect";
import { join, resolve } from "node:path";
import { expect, it, type TestContext } from "vitest";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  ProcessTestError,
} from "../../packages/client/integration/daemon-process-harness.js";
import {
  HISTORY_WIRE_VERSIONS,
  LIVE_WIRE_VERSIONS,
  WIRE_VERSION,
} from "../../packages/identity/src/version.js";
import {
  installPackedConsumer,
  packWorkspaceClosure,
  runCommand,
} from "./packed-workspace.js";

/* eslint-disable agent-code-guard/no-example-only-tests -- Regression cases exercise the reviewed release selection, reset boundary, missing metadata, and registry outage failures; the real process exchange checks interoperability. */

const RESET_SKIP_REASON =
  "No post-reset release is published; the mixed-release gate starts with the first release after the reset.";
const workspaceRoot = resolve(import.meta.dirname, "../..");
const packages = {
  "@moltzap/identity": join(workspaceRoot, "packages/identity"),
  "@moltzap/router": join(workspaceRoot, "packages/router"),
  "@moltzap/client": join(workspaceRoot, "packages/client"),
};

/** Set only after the reset release ships; absent metadata is pre-reset until then. */
const FIRST_POST_RESET_RELEASE = Option.none<string>();
const PRE_RESET_WIRE_VERSION = "pre-reset";

function preResetRelease(
  version: string,
  firstPostResetRelease?: string,
): boolean {
  if (firstPostResetRelease === undefined) {
    return true;
  }
  const parts = version.split(".").map(Number);
  const boundary = firstPostResetRelease.split(".").map(Number);
  for (const [index, part] of parts.entries()) {
    const minimum = boundary[index];
    if (minimum !== undefined && part !== minimum) {
      return part < minimum;
    }
  }
  return false;
}

/** Only registry availability failures can waive this network-dependent gate. */
function npmOutage(error: unknown): boolean {
  return (
    error instanceof Error &&
    /EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|E(?:408|429|500|502|503|504)|ERR_PNPM_FETCH_(?:408|429|500|502|503|504)|FETCH_ERROR|fetch failed/iu.test(
      error.message,
    )
  );
}

/** Wire metadata is read without downloading or installing release closures. */
function releaseWireVersion(
  version: string,
  view = npmView,
  firstPostResetRelease = FIRST_POST_RESET_RELEASE,
) {
  return view([`@moltzap/identity@${version}`]).pipe(
    Effect.flatMap(
      Schema.decodeUnknown(
        Schema.parseJson(
          Schema.Struct({
            moltzapWireVersion: Schema.optional(Schema.String),
          }),
        ),
      ),
    ),
    Effect.flatMap(({ moltzapWireVersion }) => {
      if (moltzapWireVersion !== undefined) {
        return Effect.succeed(moltzapWireVersion);
      }
      return preResetRelease(
        version,
        Option.getOrUndefined(firstPostResetRelease),
      )
        ? Effect.succeed(PRE_RESET_WIRE_VERSION)
        : Effect.fail(
            new ProcessTestError({
              message: `@moltzap/identity@${version} is missing published moltzapWireVersion metadata`,
            }),
          );
    }),
  );
}

function exchange(from: DaemonProcessFixture, to: DaemonProcessFixture) {
  return Effect.scoped(
    Effect.gen(function* () {
      const sender = yield* acquireHarnessEndpoint(from.endpoint);
      const receiver = yield* acquireHarnessEndpoint(to.endpoint);
      const waiting = yield* Stream.runHead(receiver.messages).pipe(
        Effect.forkScoped,
      );
      const text = `certified from ${from.agentName} to ${to.agentName}`;
      yield* sender.send({
        to: Schema.decodeUnknownSync(AgentAddress)(`agent:${to.agentName}`),
        text,
      });
      const received = yield* Fiber.join(waiting).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ProcessTestError({
                  message: "peer ended before certified delivery",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      expect(received.item).toMatchObject({
        kind: "multicast",
        message: { content: [{ type: "text", text }] },
      });
      yield* received.acknowledge;
    }),
  );
}

/** Calendar releases use npm's semver ordering. */
function publishedVersions() {
  return npmView(["@moltzap/client", "versions"]).pipe(
    Effect.flatMap(
      Schema.decodeUnknown(Schema.parseJson(Schema.Array(Schema.String))),
    ),
    Effect.map((versions) =>
      versions.filter((version) => /^\d{4}\.\d{3,4}\.\d+$/u.test(version)),
    ),
  );
}

/** An npm operation exhausted its transport retries, rather than returning invalid metadata. */
class NpmOutageError extends Data.TaggedError("NpmOutageError")<{
  readonly message: string;
}> {}

function npmUnavailable(error: unknown) {
  return Effect.fail(new NpmOutageError({ message: String(error) }));
}

function npmView(args: readonly string[]) {
  return runCommand("npm", [
    "view",
    ...args,
    "--json",
    "--fetch-retries=0",
    "--fetch-timeout=15000",
  ]).pipe(retryNpm);
}

function retryNpm<A, E, R>(operation: Effect.Effect<A, E, R>) {
  return operation.pipe(
    Effect.retry({
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.intersect(Schedule.recurs(2)),
      ),
      while: npmOutage,
    }),
    Effect.catchIf(npmOutage, npmUnavailable),
  );
}

function installCandidate(temporaryRoot: string, version: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      directory: temporaryRoot,
      prefix: `peer-${version}-`,
    });
    return yield* installPackedConsumer({
      temporaryRoot: root,
      workspaceRoot,
      name: "mixed-release-peer",
      archives: {},
      dependencies: Object.fromEntries(
        Object.keys(packages).map((name) => [name, version]),
      ),
    });
  }).pipe(retryNpm);
}

/** Stop at the explicit reset boundary, retaining the oldest live release. */
function selectReleases(
  versions: readonly string[],
  readVersion = releaseWireVersion,
  sets: {
    readonly live: readonly string[];
    readonly history: readonly string[];
  } = {
    live: LIVE_WIRE_VERSIONS,
    history: HISTORY_WIRE_VERSIONS,
  },
) {
  return Effect.gen(function* () {
    const previous = versions.at(-1);
    if (previous === undefined) {
      return yield* new ProcessTestError({
        message: "npm returned no calendar releases",
      });
    }
    const previousWireVersion = yield* readVersion(previous);
    if (!sets.history.includes(previousWireVersion)) {
      return [];
    }
    expect(sets.live).toContain(previousWireVersion);
    let oldest = previous;
    for (const version of [...versions].reverse().slice(1)) {
      const wireVersion = yield* readVersion(version);
      if (!sets.history.includes(wireVersion)) {
        break;
      }
      if (sets.live.includes(wireVersion)) {
        oldest = version;
      }
    }
    return [...new Set([previous, oldest])];
  });
}

function installCurrent(temporaryRoot: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      directory: temporaryRoot,
      prefix: "current-",
    });
    const { archives } = yield* packWorkspaceClosure(
      packages,
      root,
      new Set(Object.keys(packages)),
    );
    const currentRoot = join(root, "current");
    yield* fs.makeDirectory(currentRoot);
    return yield* installPackedConsumer({
      temporaryRoot: currentRoot,
      workspaceRoot,
      name: "mixed-release-current",
      archives,
    });
  }).pipe(retryNpm);
}

function certifyPair(
  infrastructure: Effect.Effect.Success<typeof acquireProcessInfrastructure>,
  version: string,
  consumer: string,
  current: string,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeDaemonProcessFixture(
        infrastructure,
        `peer-${version.replaceAll(".", "-")}`,
      );
      const local = yield* makeDaemonProcessFixture(
        infrastructure,
        `local-${version.replaceAll(".", "-")}`,
      );
      yield* acquireDaemonProcess(
        peer,
        join(consumer, "node_modules/.bin/moltzapd"),
      );
      yield* acquireDaemonProcess(
        local,
        join(current, "node_modules/.bin/moltzapd"),
      );
      for (const fixture of [peer, local]) {
        const management = yield* acquireDaemonManagementClient(
          fixture.endpoint,
        );
        const registration = yield* management.register(
          makeRegistrationRequest(fixture),
        );
        if (registration.kind !== "registered") {
          return yield* new ProcessTestError({
            message: `registration failed for ${fixture.agentName}`,
          });
        }
      }
      yield* exchange(local, peer);
      yield* exchange(peer, local);
    }),
  );
}

const mixedRelease = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporaryRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "mixed-release-",
    });
    const versions = yield* publishedVersions();
    const releases = yield* selectReleases(versions);
    if (releases.length === 0) {
      return RESET_SKIP_REASON;
    }
    const current = yield* installCurrent(temporaryRoot);
    const infrastructure = yield* acquireProcessInfrastructure;
    for (const version of releases) {
      const consumer = yield* installCandidate(temporaryRoot, version);
      yield* certifyPair(infrastructure, version, consumer, current);
    }
    return undefined;
  }),
).pipe(
  Effect.catchTag("NpmOutageError", (error) =>
    Effect.succeed(
      `npm outage after retries; mixed-release gate skipped: ${String(error)}`,
    ),
  ),
  Effect.provide(NodeContext.layer),
);

function runMixedRelease(context: TestContext) {
  const fiber = Effect.runFork(mixedRelease);
  context.onTestFinished(
    () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid)),
    60_000,
  );
  return Effect.runPromise(
    Fiber.join(fiber).pipe(
      Effect.tap((reason) =>
        reason === undefined
          ? Effect.void
          : Effect.logWarning(reason).pipe(
              Effect.zipRight(Effect.sync(() => context.skip(reason))),
            ),
      ),
      Effect.asVoid,
    ),
  );
}

it(
  "certifies with the previous and oldest in-window published releases",
  runMixedRelease,
  600_000,
);

it("selects the oldest live peer rather than an older retained peer", () =>
  Effect.runPromise(
    selectReleases(
      ["2099.101.0", "2099.102.0", "2099.103.0", "2099.104.0"],
      (version) =>
        Effect.succeed(
          new Map([
            ["2099.104.0", "new"],
            ["2099.101.0", "retired"],
          ]).get(version) ?? "old",
        ),
      { live: ["old", "new"], history: ["retired", "old", "new"] },
    ).pipe(
      Effect.provide(NodeContext.layer),
      Effect.tap((releases) =>
        Effect.sync(() => {
          expect(releases).toEqual(["2099.104.0", "2099.102.0"]);
        }),
      ),
    ),
  ));

it("runs a single peer when the previous release is also the oldest live release", () =>
  Effect.runPromise(
    selectReleases(
      ["2099.101.0", "2099.102.0"],
      (version) =>
        Effect.succeed(version === "2099.101.0" ? "pre-reset" : "new"),
      { live: ["new"], history: ["new"] },
    ).pipe(
      Effect.provide(NodeContext.layer),
      Effect.tap((releases) =>
        Effect.sync(() => {
          expect(releases).toEqual(["2099.102.0"]);
        }),
      ),
    ),
  ));

it("skips only when the previous release is outside retained history", () =>
  Effect.runPromise(
    selectReleases(
      ["2099.101.0"],
      () => Effect.succeed(PRE_RESET_WIRE_VERSION),
      {
        live: ["new"],
        history: ["new"],
      },
    ).pipe(
      Effect.provide(NodeContext.layer),
      Effect.tap((releases) =>
        Effect.sync(() => {
          expect(releases).toEqual([]);
        }),
      ),
    ),
  ));

it.each(["2099.101.0", "2099.102.0"])(
  "fails when post-reset release %s omits wire metadata",
  (version) =>
    Effect.runPromise(
      releaseWireVersion(
        version,
        () => Effect.succeed("{}"),
        Option.some("2099.101.0"),
      ).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toMatchObject({
              _tag: "ProcessTestError",
              message: `@moltzap/identity@${version} is missing published moltzapWireVersion metadata`,
            });
          }),
        ),
        Effect.provide(NodeContext.layer),
        Effect.asVoid,
      ),
    ),
);

it.each([
  ["2026.1019.1", Option.none<string>()],
  ["2099.101.0", Option.none<string>()],
  ["2099.100.0", Option.some("2099.101.0")],
])(
  "treats metadata-free %s as pre-reset before boundary %s",
  (version, boundary) =>
    Effect.runPromise(
      releaseWireVersion(version, () => Effect.succeed("{}"), boundary).pipe(
        Effect.tap((wireVersion) =>
          Effect.sync(() => {
            expect(wireVersion).toBe(PRE_RESET_WIRE_VERSION);
          }),
        ),
        Effect.provide(NodeContext.layer),
        Effect.asVoid,
      ),
    ),
);

it("reads published wire metadata at the reset boundary", () =>
  Effect.runPromise(
    releaseWireVersion(
      "2099.101.0",
      () =>
        Effect.succeed(JSON.stringify({ moltzapWireVersion: WIRE_VERSION })),
      Option.some("2099.101.0"),
    ).pipe(
      Effect.tap((wireVersion) =>
        Effect.sync(() => {
          expect(wireVersion).toBe(WIRE_VERSION);
        }),
      ),
      Effect.provide(NodeContext.layer),
    ),
  ));

it.each([
  ["npm error code E503", true],
  ["npm error code EAI_AGAIN", true],
  ["ERR_PNPM_FETCH_503 Service Unavailable - 503", true],
  ["ERR_PNPM_FETCH_429 Too Many Requests - 429", true],
  ["ERR_PNPM_FETCH_404 Not Found - 404", false],
  ["npm error code E404", false],
  ["invalid release metadata", false],
])("classifies registry availability: %s", (message, outage) => {
  expect(npmOutage(new Error(message))).toBe(outage);
});

/* eslint-enable agent-code-guard/no-example-only-tests -- Restore default testing policy outside these regression scenarios. */
