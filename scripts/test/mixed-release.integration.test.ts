/** @file Published peers and the current daemon certify posts in both directions. */

import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { acquireHarnessEndpoint, AgentAddress } from "@moltzap/client";
import { Effect, Fiber, Option, Schema, Stream } from "effect";
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
} from "../../packages/identity/src/version.js";
import {
  installPackedConsumer,
  packWorkspaceClosure,
  runCommand,
} from "./packed-workspace.js";

const RESET_SKIP_REASON =
  "No post-reset release is published; the mixed-release gate starts with the first release after the reset.";
const workspaceRoot = resolve(import.meta.dirname, "../..");
const packages = {
  "@moltzap/identity": join(workspaceRoot, "packages/identity"),
  "@moltzap/router": join(workspaceRoot, "packages/router"),
  "@moltzap/client": join(workspaceRoot, "packages/client"),
};

/** Read published metadata through its public exports, never its private file layout. */
function installRelease(temporaryRoot: string, version: string) {
  return Effect.gen(function* () {
    const consumer = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "mixed-release-peer",
      archives: {},
      dependencies: Object.fromEntries(
        Object.keys(packages).map((name) => [name, version]),
      ),
    });
    const output = yield* runCommand(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const identity = await import("@moltzap/identity"); console.log(JSON.stringify({wireVersion: identity.WIRE_VERSION ?? null}));',
      ],
      { cwd: consumer },
    );
    const { wireVersion } = yield* Schema.decodeUnknown(
      Schema.parseJson(
        Schema.Struct({ wireVersion: Schema.NullOr(Schema.String) }),
      ),
    )(output.trim());
    return { consumer, wireVersion };
  });
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
  return runCommand("npm", [
    "view",
    "@moltzap/client",
    "versions",
    "--json",
  ]).pipe(
    Effect.flatMap(
      Schema.decodeUnknown(Schema.parseJson(Schema.Array(Schema.String))),
    ),
    Effect.map((versions) =>
      versions.filter((version) => /^\d{4}\.\d{3,4}\.\d+$/u.test(version)),
    ),
  );
}

function installCandidate(temporaryRoot: string, version: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = join(temporaryRoot, version);
    yield* fs.makeDirectory(root);
    return yield* installRelease(root, version);
  });
}

/** History retains the second-version witness even after the live window shrinks. */
function oldestPeer(
  temporaryRoot: string,
  versions: readonly string[],
  previous: string,
) {
  return Effect.gen(function* () {
    if (HISTORY_WIRE_VERSIONS.length <= 1) {
      return undefined;
    }
    for (const version of versions.filter((version) => version !== previous)) {
      const candidate = yield* installCandidate(temporaryRoot, version);
      if (
        LIVE_WIRE_VERSIONS.some(
          (wireVersion) => wireVersion === candidate.wireVersion,
        )
      ) {
        return { version, consumer: candidate.consumer };
      }
    }
    return undefined;
  });
}

function installCurrent(temporaryRoot: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { archives } = yield* packWorkspaceClosure(
      packages,
      temporaryRoot,
      new Set(Object.keys(packages)),
    );
    const currentRoot = join(temporaryRoot, "current");
    yield* fs.makeDirectory(currentRoot);
    return yield* installPackedConsumer({
      temporaryRoot: currentRoot,
      workspaceRoot,
      name: "mixed-release-current",
      archives,
    });
  });
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
    const previous = versions.at(-1);
    if (previous === undefined) {
      return yield* new ProcessTestError({
        message: "npm returned no calendar releases",
      });
    }
    const installed = yield* installCandidate(temporaryRoot, previous);
    if (installed.wireVersion === null) {
      return RESET_SKIP_REASON;
    }
    expect(LIVE_WIRE_VERSIONS).toContain(installed.wireVersion);
    const releases = new Map([[previous, installed.consumer]]);
    const oldest = yield* oldestPeer(temporaryRoot, versions, previous);
    if (oldest !== undefined) {
      releases.set(oldest.version, oldest.consumer);
    }
    const current = yield* installCurrent(temporaryRoot);
    const infrastructure = yield* acquireProcessInfrastructure;
    for (const [version, consumer] of releases) {
      yield* certifyPair(infrastructure, version, consumer, current);
    }
    return undefined;
  }),
).pipe(Effect.provide(NodeContext.layer));

function runMixedRelease(context: TestContext) {
  const fiber = Effect.runFork(mixedRelease);
  context.onTestFinished(
    () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid)),
    60_000,
  );
  return Effect.runPromise(
    Fiber.join(fiber).pipe(
      Effect.tap((reason) =>
        Effect.sync(() => {
          if (reason !== undefined) {
            context.skip(reason);
          }
        }),
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
