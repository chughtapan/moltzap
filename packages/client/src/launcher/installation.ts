/**
 * @file The launcher's state on the agent's home volume: the record of the
 * release the agent runs, the verified tarballs that release was installed
 * from, one installed prefix per release, and the `current` link hosts load
 * the channel through. An installed prefix is written once, from verified
 * tarballs, and only read after.
 */

import {
  Command,
  type CommandExecutor,
  FileSystem,
  Path,
} from "@effect/platform";
import { Effect, Option, Schema, Stream } from "effect";
import { launcherError, type LauncherError } from "./errors.js";
import { integrityOf } from "./integrity.js";
import { DAEMON_PACKAGE, IDENTITY_PACKAGE } from "./registry.js";

const RECORD_FORMAT = "org.social-harness/launcher-record/v1";

const installedPackage = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  integrity: Schema.String,
  tarball: Schema.String,
});

/** One package of a verified release, and the cached tarball it came from. */
export type InstalledPackage = typeof installedPackage.Type;

const recordSchema = Schema.Struct({
  format: Schema.Literal(RECORD_FORMAT),
  releasePackage: Schema.String,
  version: Schema.String,
  prefix: Schema.String,
  hostCodeHash: Schema.optional(Schema.String),
  /** Empty for the release the image installed, which the image vouches for. */
  packages: Schema.Array(installedPackage),
});

/** The release an agent runs, as the home volume records it. */
export type LauncherRecord = typeof recordSchema.Type;

/** One verified tarball, ready to cache and install. */
export interface VerifiedTarball {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly bytes: Uint8Array;
}

/** A verified release to install. */
export interface ReleaseToInstall {
  readonly releasePackage: string;
  readonly version: string;
  /** Every `@moltzap/*` tarball of the release. */
  readonly tarballs: readonly VerifiedTarball[];
  /** The registry the remaining dependencies come from. */
  readonly registry: string;
}

const RECORD_FILE = "launcher.json";
const CURRENT_LINK = "current";

const manifestSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  sharnessHostCodeHash: Schema.optional(Schema.String),
  exports: Schema.optional(Schema.Unknown),
});

type InstalledManifest = typeof manifestSchema.Type;

const identityExports = Schema.Struct({
  ".": Schema.Struct({ import: Schema.String }),
});

const liveWindow = Schema.Struct({
  LIVE_WIRE_VERSIONS: Schema.Array(Schema.String),
});

/** The record in launcher directory `directory`, none, or a `record` failure. */
export const readRecord = Effect.fn("Launcher.readRecord")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, RECORD_FILE);
  const exists = yield* fs
    .exists(file)
    .pipe(Effect.mapError(() => recordFailure(file)));
  if (!exists) {
    return Option.none<LauncherRecord>();
  }
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(recordSchema))),
    Effect.map(Option.some),
    Effect.mapError(() => recordFailure(file)),
  );
});

/**
 * Replaces the record in `directory` atomically, so a crash leaves the old
 * or the new one, or fails with `record`.
 */
export const writeRecord = Effect.fn("Launcher.writeRecord")(
  function* (directory: string, record: LauncherRecord) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, RECORD_FILE);
    const temporary = `${file}.tmp`;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      temporary,
      `${JSON.stringify(record, null, 2)}\n`,
    );
    yield* fs.rename(temporary, file);
  },
  Effect.mapError((failure) => launcherError("record", failure.message)),
);

/**
 * The record of the release the image installed under `prefix`, whose
 * `node_modules` holds `releasePackage`, or a `seed` failure.
 */
export const seedRecord = Effect.fn("Launcher.seedRecord")(
  function* (prefix: string, releasePackage: string) {
    const manifest = yield* installedManifest(prefix, releasePackage);
    return recordOf(releasePackage, prefix, manifest, []);
  },
  Effect.mapError((failure) => launcherError("seed", failure.message)),
);

/**
 * Checks, without the network, that every cached tarball of `record` still
 * has the integrity it was verified with and that its prefix holds the
 * recorded release; fails with `integrity` otherwise.
 */
export const checkIntegrity = Effect.fn("Launcher.checkIntegrity")(
  function* (record: LauncherRecord) {
    const fs = yield* FileSystem.FileSystem;
    for (const installed of record.packages) {
      const bytes = yield* fs.readFile(installed.tarball);
      if (integrityOf(bytes) !== installed.integrity) {
        return yield* launcherError(
          "integrity",
          `${installed.tarball} no longer matches ${installed.name}@${installed.version}`,
        );
      }
    }
    const manifest = yield* installedManifest(
      record.prefix,
      record.releasePackage,
    );
    if (manifest.version !== record.version) {
      return yield* launcherError(
        "integrity",
        `${record.prefix} holds ${record.releasePackage}@${manifest.version}, not the recorded ${record.version}`,
      );
    }
  },
  Effect.mapError((failure) => launcherError("integrity", failure.message)),
);

/**
 * Caches the release's tarballs in `directory` and installs them into a new
 * prefix, fetching only their dependencies outside the scope from the
 * registry; fails with `install`.
 */
export const install = Effect.fn("Launcher.install")(
  function* (directory: string, release: ReleaseToInstall) {
    const path = yield* Path.Path;
    const packages = yield* cacheTarballs(
      path.join(directory, "tarballs"),
      release.tarballs,
    );
    const prefix = path.join(
      directory,
      "releases",
      `${fileName(release.releasePackage)}-${release.version}`,
    );
    yield* installInto(prefix, packages, release.registry);
    const manifest = yield* installedManifest(prefix, release.releasePackage);
    return recordOf(release.releasePackage, prefix, manifest, packages);
  },
  Effect.mapError((failure) => launcherError("install", failure.message)),
);

/**
 * Points `current` in `directory` at `prefix` atomically, so a host that
 * loads the channel through it sees one whole release; fails with `record`.
 */
export const pointCurrent = Effect.fn("Launcher.pointCurrent")(
  function* (directory: string, prefix: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const link = path.join(directory, CURRENT_LINK);
    const temporary = `${link}.tmp`;
    yield* fs.remove(temporary, { force: true });
    yield* fs.symlink(prefix, temporary);
    yield* fs.rename(temporary, link);
  },
  Effect.mapError((failure) => launcherError("record", failure.message)),
);

/**
 * The wire versions the daemon installed under `prefix` admits, read from
 * the Identity package it runs, or an `integrity` failure.
 */
export const liveWireVersions = Effect.fn("Launcher.liveWireVersions")(
  function* (prefix: string) {
    const path = yield* Path.Path;
    const manifest = yield* installedManifest(prefix, IDENTITY_PACKAGE);
    const entry = yield* Schema.decodeUnknown(identityExports)(
      manifest.exports,
    );
    const module = path.join(
      prefix,
      "node_modules",
      IDENTITY_PACKAGE,
      entry["."].import,
    );
    const loaded: unknown = yield* Effect.tryPromise(() => import(module));
    const window = yield* Schema.decodeUnknown(liveWindow)(loaded);
    return window.LIVE_WIRE_VERSIONS;
  },
  Effect.mapError(() =>
    launcherError(
      "integrity",
      "the recorded release holds no readable Identity package",
    ),
  ),
);

/**
 * The `sharnessd` executable installed under `prefix`.
 *
 * @param prefix An installed release.
 * @returns The path the launcher runs with the current Node.
 */
export const daemonExecutable = (
  prefix: string,
): Effect.Effect<string, never, Path.Path> =>
  Effect.map(Path.Path, (path) =>
    path.join(prefix, "node_modules", DAEMON_PACKAGE, "bin", "sharnessd"),
  );

function cacheTarballs(
  cache: string,
  tarballs: readonly VerifiedTarball[],
): Effect.Effect<
  readonly InstalledPackage[],
  LauncherError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(cache, { recursive: true });
    return yield* Effect.forEach(
      tarballs,
      (tarball) => {
        const file = path.join(
          cache,
          `${fileName(tarball.name)}-${tarball.version}.tgz`,
        );
        return fs.writeFile(file, tarball.bytes).pipe(
          Effect.as({
            name: tarball.name,
            version: tarball.version,
            integrity: tarball.integrity,
            tarball: file,
          }),
        );
      },
      { concurrency: 1 },
    );
  }).pipe(
    Effect.mapError(() => launcherError("install", `could not write ${cache}`)),
  );
}

/** Installs `packages` into a staging directory, then moves it to `prefix`. */
function installInto(
  prefix: string,
  packages: readonly InstalledPackage[],
  registry: string,
): Effect.Effect<
  void,
  LauncherError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> {
  const staging = `${prefix}.partial`;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(staging, { recursive: true, force: true });
    yield* fs.makeDirectory(staging, { recursive: true });
    yield* fs.writeFileString(
      `${staging}/package.json`,
      `${JSON.stringify({ private: true })}\n`,
    );
    const exitCode = yield* npmInstall(staging, packages, registry);
    if (exitCode !== 0) {
      return yield* launcherError(
        "install",
        `npm install exited ${exitCode} in ${staging}`,
      );
    }
    yield* fs.remove(prefix, { recursive: true, force: true });
    yield* fs.rename(staging, prefix);
  }).pipe(
    Effect.catchTags({
      BadArgument: () => Effect.fail(installFailure(prefix)),
      SystemError: () => Effect.fail(installFailure(prefix)),
    }),
  );
}

/**
 * Runs `npm install` of the cached tarballs in `staging`. Install scripts
 * never run; npm's progress output is dropped and its errors reach stderr.
 */
function npmInstall(
  staging: string,
  packages: readonly InstalledPackage[],
  registry: string,
): Effect.Effect<number, LauncherError, CommandExecutor.CommandExecutor> {
  return Effect.scoped(
    Effect.gen(function* () {
      const npm = yield* Command.make(
        "npm",
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-progress",
        "--omit=dev",
        `--registry=${registry}`,
        ...packages.map((installed) => installed.tarball),
      ).pipe(
        Command.workingDirectory(staging),
        Command.stderr("inherit"),
        Command.start,
      );
      const [, code] = yield* Effect.all(
        [Stream.runDrain(npm.stdout), npm.exitCode],
        { concurrency: 2 },
      );
      return code;
    }),
  ).pipe(
    Effect.mapError(() =>
      launcherError("install", `npm install could not run in ${staging}`),
    ),
  );
}

function installedManifest(
  prefix: string,
  name: string,
): Effect.Effect<
  InstalledManifest,
  LauncherError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(prefix, "node_modules", name, "package.json");
    const refuse = launcherError(
      "install",
      `${file} is not a readable ${name} manifest`,
    );
    const manifest = yield* fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(manifestSchema))),
      Effect.mapError(() => refuse),
    );
    return manifest.name === name ? manifest : yield* refuse;
  });
}

function recordOf(
  releasePackage: string,
  prefix: string,
  manifest: InstalledManifest,
  packages: readonly InstalledPackage[],
): LauncherRecord {
  return {
    format: RECORD_FORMAT,
    releasePackage,
    version: manifest.version,
    prefix,
    ...(manifest.sharnessHostCodeHash === undefined
      ? {}
      : { hostCodeHash: manifest.sharnessHostCodeHash }),
    packages,
  };
}

function fileName(name: string): string {
  return name.replace("@", "").replace("/", "-");
}

function installFailure(prefix: string): LauncherError {
  return launcherError("install", `could not install into ${prefix}`);
}

function recordFailure(file: string): LauncherError {
  return launcherError("record", `${file} could not be read`);
}
