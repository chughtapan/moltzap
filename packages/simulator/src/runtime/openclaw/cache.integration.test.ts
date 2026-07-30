import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Config, Data, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeCommandHelpers } from "../command.js";
import {
  makeOpenClawCommand,
  materializePublishedOpenClawPlugin,
} from "./cache.js";
import {
  resolveInstalledPackageBin,
  resolveInstalledPackageDependency,
} from "../packages.js";

const OPENCLAW_PLUGIN_ID = "openclaw-channel";
const CHANNEL_PACKAGE_NAME = "@moltzap/openclaw-channel";
const SIMULATOR_PACKAGE_NAME = "@moltzap/simulator";
const OPENCLAW_COMMAND_TIMEOUT_MS = 30_000;
// The cold path runs a real npm install (measured ~60s) plus a full
// per-agent materialization before its assertions.
const OPENCLAW_INSTALL_TEST_TIMEOUT_MS = 600_000;
const JSON_INDENT_SPACES = 2;
const LOADED_PLUGIN_STATUS = "loaded";
const NPM_INSTALL_SOURCE = "npm";
const PROVENANCE_DIAGNOSTIC_PATTERN = /provenance|untracked/i;

const openClawPluginInfoOutput = Schema.Struct({
  plugin: Schema.Struct({
    id: Schema.String,
    enabled: Schema.Boolean,
    status: Schema.String,
  }),
  install: Schema.Struct({
    source: Schema.String,
    spec: Schema.String,
  }),
  diagnostics: Schema.Array(
    Schema.Struct({
      level: Schema.Literal("warn", "error"),
      message: Schema.String,
    }),
  ),
});

class OpenClawIntegrationCommandError extends Data.TaggedError(
  "OpenClawIntegrationCommandError",
)<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

function commandError(reason: string, cause?: unknown) {
  return new OpenClawIntegrationCommandError({
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}

const { commandOutputEffect } = makeCommandHelpers(commandError);

interface PublishedPluginFixture {
  readonly home: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly expectedChannelSpec: string;
  readonly openclawBin: string;
}

// Integration gates use Config so test modules follow the same environment
// boundary as runtime code.
const OPENCLAW_INSTALL_INTEGRATION_ENABLED = Effect.runSync(
  Config.string("MOLTZAP_OPENCLAW_ITEST").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
);

describe.skipIf(!OPENCLAW_INSTALL_INTEGRATION_ENABLED)(
  "OpenClaw real published plugin cache",
  () => {
    it(
      "retains npm provenance after per-agent materialization",
      verifiesPublishedPluginProvenance,
      OPENCLAW_INSTALL_TEST_TIMEOUT_MS,
    );
  },
);

function verifiesPublishedPluginProvenance() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "openclaw-plugin-cache-integration-",
        });
        const fixture = yield* preparePublishedPluginFixture(root);
        yield* assertPublishedPluginInfo(fixture);
      }).pipe(Effect.provide(NodeContext.layer)),
    ),
  );
}

function preparePublishedPluginFixture(root: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDir = join(root, "agent-state");
    const configPath = join(stateDir, "openclaw.json");
    const openclawBin = resolveInstalledPackageBin("openclaw", "openclaw");
    const channel = yield* Effect.try({
      try: () =>
        resolveInstalledPackageDependency(
          SIMULATOR_PACKAGE_NAME,
          CHANNEL_PACKAGE_NAME,
          import.meta.url,
        ),
      catch: (cause) =>
        commandError("Unable to resolve the expected channel version", cause),
    });
    yield* materializePublishedOpenClawPlugin({
      stateDir,
      openclawBin,
      cacheBaseDir: join(root, "cache"),
    });
    yield* fileSystem.writeFileString(
      configPath,
      JSON.stringify({}, null, JSON_INDENT_SPACES),
    );
    return {
      home: root,
      environment: {
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      expectedChannelSpec: `${CHANNEL_PACKAGE_NAME}@${channel.version}`,
      openclawBin,
    } satisfies PublishedPluginFixture;
  });
}

function assertPublishedPluginInfo(fixture: PublishedPluginFixture) {
  return Effect.gen(function* () {
    const infoCommand = yield* makeOpenClawCommand(
      fixture.openclawBin,
      ["plugins", "info", OPENCLAW_PLUGIN_ID, "--runtime", "--json"],
      fixture.environment,
      fixture.home,
    );
    const infoOutput = yield* commandOutputEffect(
      "inspect materialized OpenClaw plugin",
      infoCommand,
      { timeout: OPENCLAW_COMMAND_TIMEOUT_MS },
    );
    const info = yield* decodePluginInfo(infoOutput.stdout);
    expect(info.plugin).toMatchObject({
      id: OPENCLAW_PLUGIN_ID,
      enabled: true,
      status: LOADED_PLUGIN_STATUS,
    });
    expect(info.install).toEqual({
      source: NPM_INSTALL_SOURCE,
      spec: fixture.expectedChannelSpec,
    });
    expect(
      info.diagnostics.some((diagnostic) =>
        PROVENANCE_DIAGNOSTIC_PATTERN.test(diagnostic.message),
      ),
    ).toBe(false);
    expect(infoOutput.stderr).not.toMatch(PROVENANCE_DIAGNOSTIC_PATTERN);
  });
}

function decodePluginInfo(output: string) {
  return Effect.try({
    try: (): unknown => JSON.parse(output),
    catch: (cause) => commandError("OpenClaw returned invalid JSON", cause),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(openClawPluginInfoOutput)),
    Effect.mapError((cause) =>
      cause instanceof OpenClawIntegrationCommandError
        ? cause
        : commandError("Unable to decode OpenClaw plugin info", cause),
    ),
  );
}
