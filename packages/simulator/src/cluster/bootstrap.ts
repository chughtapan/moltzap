/** @file Private runtime-bootstrap materializer used by the Sandbox initializer. */

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- `FileSystem.stat` resolves the final symbolic link and `@effect/platform` exposes no `lstat`, so link-rejecting checks need Node directly; entry detection runs at module load, before a runtime exists to provide `FileSystem`.
import { existsSync, promises as nodeFsPromises, realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Data, Effect } from "effect";

const BOOTSTRAP_API_VERSION = "moltzap.bootstrap/v1";
const ROOT_KEYS = new Set(["apiVersion", "files"]);
const FILE_KEYS = new Set(["source", "path", "mode"]);
const CLI_FLAGS = ["--manifest", "--source", "--output", "--overlay"] as const;
const MAX_FILE_MODE = 0o777;

/** A Secret entry names one file, so a separator or NUL is hostile. */
const NAME_REJECTED_CHARACTERS = ["/", "\\", "\0"];

/** A target path nests with `/`; a backslash or NUL is never a POSIX segment. */
const PATH_REJECTED_CHARACTERS = ["\\", "\0"];

type BootstrapFlag = (typeof CLI_FLAGS)[number];

/**
 * What a path is when its own final symbolic link is not followed.
 *
 * Every check below treats a link as hostile: a Secret or overlay mount
 * escapes the tree it was projected into by pointing somewhere else. `lstat`
 * reports the link itself, so `symlink` satisfies neither the directory nor
 * the regular-file check, while `stat` would report the link's target.
 */
type PathKind = "directory" | "file" | "missing" | "symlink" | "other";

interface BootstrapFile {
  readonly source: string;
  readonly path: string;
  readonly mode: number;
}

interface BootstrapManifest {
  readonly apiVersion: typeof BOOTSTRAP_API_VERSION;
  readonly files: readonly BootstrapFile[];
}

interface ResolvedBootstrapFile extends BootstrapFile {
  readonly resolvedSource: string;
}

/** Filesystem locations consumed by one bootstrap materialization. */
export interface BootstrapMaterializationOptions {
  readonly manifest: string;
  readonly source: string;
  readonly output: string;
  readonly overlay: string;
}

/** A refused bootstrap input or a filesystem call the initializer cannot trust. */
export class BootstrapError extends Data.TaggedError("BootstrapError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** An absent path, which several callers answer with creation rather than failure. */
class PathMissing extends Data.TaggedError("PathMissing")<{
  readonly path: string;
}> {}

function bootstrapError(detail: string): BootstrapError {
  return new BootstrapError({ detail });
}

function reject(detail: string): Effect.Effect<never, BootstrapError> {
  return Effect.fail(bootstrapError(detail));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function containsAny(value: string, characters: readonly string[]): boolean {
  return characters.some((character) => value.includes(character));
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): Effect.Effect<void, BootstrapError> {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  return unknown === undefined
    ? Effect.void
    : reject(`${label} has unknown key ${unknown}`);
}

function isPlainFileName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (value === "." || value === "..") {
    return false;
  }
  return !containsAny(value, NAME_REJECTED_CHARACTERS);
}

function sourceName(
  value: unknown,
  label: string,
): Effect.Effect<string, BootstrapError> {
  return isPlainFileName(value)
    ? Effect.succeed(value)
    : reject(`${label} must be one plain file name`);
}

function isNormalizedRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (containsAny(value, PATH_REJECTED_CHARACTERS)) {
    return false;
  }
  if (posix.isAbsolute(value)) {
    return false;
  }
  return posix.normalize(value) === value;
}

function isContainedSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== "..";
}

function targetPath(
  value: unknown,
  label: string,
): Effect.Effect<string, BootstrapError> {
  if (!isNormalizedRelativePath(value)) {
    return reject(`${label} must be a normalized relative path`);
  }
  if (!value.split("/").every(isContainedSegment)) {
    return reject(`${label} must stay below the bootstrap output`);
  }
  return Effect.succeed(value);
}

function isPermissionBits(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return false;
  }
  return value >= 0 && value <= MAX_FILE_MODE;
}

function fileMode(
  value: unknown,
  label: string,
): Effect.Effect<number, BootstrapError> {
  return isPermissionBits(value)
    ? Effect.succeed(value)
    : reject(`${label} must contain only Unix permission bits`);
}

function decodeFile(
  candidate: unknown,
  index: number,
  targets: Set<string>,
): Effect.Effect<BootstrapFile, BootstrapError> {
  const label = `bootstrap manifest files[${String(index)}]`;
  return Effect.gen(function* () {
    if (!isRecord(candidate)) {
      return yield* reject(`${label} must be an object`);
    }
    yield* rejectUnknownKeys(candidate, FILE_KEYS, label);
    const path = yield* targetPath(candidate.path, `${label}.path`);
    if (targets.has(path)) {
      return yield* reject(`bootstrap manifest repeats target ${path}`);
    }
    targets.add(path);
    const source = yield* sourceName(candidate.source, `${label}.source`);
    const mode = yield* fileMode(candidate.mode, `${label}.mode`);
    return { source, path, mode };
  });
}

function decodeManifest(
  value: unknown,
): Effect.Effect<BootstrapManifest, BootstrapError> {
  return Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* reject("bootstrap manifest must be an object");
    }
    yield* rejectUnknownKeys(value, ROOT_KEYS, "bootstrap manifest");
    if (value.apiVersion !== BOOTSTRAP_API_VERSION) {
      return yield* reject(
        `bootstrap manifest apiVersion must be ${BOOTSTRAP_API_VERSION}`,
      );
    }
    if (!isUnknownArray(value.files)) {
      return yield* reject("bootstrap manifest files must be an array");
    }

    const targets = new Set<string>();
    const files = yield* Effect.forEach(
      value.files,
      (candidate, index) => decodeFile(candidate, index, targets),
      // Sequential so the first hostile entry, not a race, names the failure.
      { concurrency: 1 },
    );
    return { apiVersion: BOOTSTRAP_API_VERSION, files };
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function pathKind(path: string): Effect.Effect<PathKind, BootstrapError> {
  return Effect.tryPromise({
    try: () => nodeFsPromises.lstat(path),
    catch: (cause) =>
      hasErrorCode(cause, "ENOENT")
        ? new PathMissing({ path })
        : bootstrapError(`bootstrap could not inspect ${path}`),
  }).pipe(
    Effect.map((entry): PathKind => {
      if (entry.isSymbolicLink()) {
        return "symlink";
      }
      if (entry.isDirectory()) {
        return "directory";
      }
      return entry.isFile() ? "file" : "other";
    }),
    Effect.catchTag("PathMissing", () => Effect.succeed<PathKind>("missing")),
  );
}

function requireDirectory(
  path: string,
  label: string,
): Effect.Effect<void, BootstrapError> {
  return pathKind(path).pipe(
    Effect.flatMap((kind) =>
      kind === "directory"
        ? Effect.void
        : reject(`${label} must be a directory`),
    ),
  );
}

function ensureOutputDirectory(
  path: string,
): Effect.Effect<void, BootstrapError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const kind = yield* pathKind(path);
    if (kind === "directory") {
      return;
    }
    if (kind !== "missing") {
      return yield* reject("bootstrap output must be a directory");
    }
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .makeDirectory(path, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          bootstrapError("bootstrap output cannot be created"),
        ),
      );
    yield* requireDirectory(path, "bootstrap output");
  });
}

function escapesRoot(projection: string): boolean {
  if (projection === "..") {
    return true;
  }
  return projection.startsWith(`..${sep}`) || isAbsolute(projection);
}

function resolveRegularSource(
  sourceRoot: string,
  source: string,
  name: string,
): Effect.Effect<string, BootstrapError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const resolved = yield* fileSystem
      .realPath(join(source, name))
      .pipe(
        Effect.mapError(() =>
          bootstrapError(`bootstrap source ${name} cannot be resolved`),
        ),
      );
    if (escapesRoot(relative(sourceRoot, resolved))) {
      return yield* reject(
        `bootstrap source ${name} resolves outside its mount`,
      );
    }
    const kind = yield* pathKind(resolved);
    if (kind !== "file") {
      return yield* reject(
        `bootstrap source ${name} must resolve to a regular file`,
      );
    }
    return resolved;
  });
}

function ensureTargetDirectory(
  path: string,
  relativePath: string,
): Effect.Effect<void, BootstrapError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const kind = yield* pathKind(path);
    if (kind === "directory") {
      return;
    }
    if (kind !== "missing") {
      return yield* reject(
        `bootstrap target parent is not a directory: ${relativePath}`,
      );
    }
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .makeDirectory(path)
      .pipe(
        Effect.mapError(() =>
          bootstrapError(
            `bootstrap target parent cannot be created: ${relativePath}`,
          ),
        ),
      );
  });
}

function ensureRegularDestination(
  path: string,
  relativePath: string,
): Effect.Effect<void, BootstrapError> {
  return pathKind(path).pipe(
    Effect.flatMap((kind) =>
      kind === "file" || kind === "missing"
        ? Effect.void
        : reject(`bootstrap target is not a regular file: ${relativePath}`),
    ),
  );
}

function ensureTargetParent(
  output: string,
  relativePath: string,
): Effect.Effect<string, BootstrapError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const segments = relativePath.split("/");
    const filename = segments.pop();
    if (filename === undefined) {
      return yield* reject("bootstrap target has no filename");
    }

    let parent = output;
    for (const segment of segments) {
      parent = join(parent, segment);
      yield* ensureTargetDirectory(parent, relativePath);
    }

    const destination = join(parent, filename);
    yield* ensureRegularDestination(destination, relativePath);
    return destination;
  });
}

function readManifest(
  path: string,
): Effect.Effect<BootstrapManifest, BootstrapError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* fileSystem
      .readFileString(path)
      .pipe(
        Effect.mapError(() =>
          bootstrapError("bootstrap manifest cannot be read"),
        ),
      );
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(encoded),
      catch: () => bootstrapError("bootstrap manifest is not valid JSON"),
    });
    return yield* decodeManifest(parsed);
  });
}

function resolveManifestSources(
  options: BootstrapMaterializationOptions,
  manifest: BootstrapManifest,
): Effect.Effect<
  readonly ResolvedBootstrapFile[],
  BootstrapError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* requireDirectory(options.source, "bootstrap source");
    yield* requireDirectory(options.overlay, "bootstrap overlay");
    const sourceRoot = yield* fileSystem
      .realPath(options.source)
      .pipe(
        Effect.mapError(() =>
          bootstrapError("bootstrap source cannot be resolved"),
        ),
      );
    return yield* Effect.forEach(
      manifest.files,
      (file) =>
        resolveRegularSource(sourceRoot, options.source, file.source).pipe(
          Effect.map((resolvedSource) => ({ ...file, resolvedSource })),
        ),
      // Sequential so the first hostile entry, not a race, names the failure.
      { concurrency: 1 },
    );
  });
}

function placeFile(
  output: string,
  file: ResolvedBootstrapFile,
): Effect.Effect<void, BootstrapError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const destination = yield* ensureTargetParent(output, file.path);
    yield* fileSystem
      .copyFile(file.resolvedSource, destination)
      .pipe(
        Effect.mapError(() =>
          bootstrapError(`bootstrap target cannot be written: ${file.path}`),
        ),
      );
    yield* fileSystem
      .chmod(destination, file.mode)
      .pipe(
        Effect.mapError(() =>
          bootstrapError(`bootstrap target cannot take its mode: ${file.path}`),
        ),
      );
  });
}

/**
 * Copy the application overlay and then materialize its run-scoped files.
 *
 * Every manifest entry is decoded and resolved before the output directory
 * exists, so a refused bootstrap leaves the application with nothing to read.
 * @param options Trusted mount and output paths owned by the initializer.
 * @returns Completion after every file has its declared mode.
 * @failure BootstrapError when an input is refused or a copy cannot be trusted.
 */
export function materializeBootstrap(
  options: BootstrapMaterializationOptions,
): Effect.Effect<void, BootstrapError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const manifest = yield* readManifest(options.manifest);
    const files = yield* resolveManifestSources(options, manifest);

    yield* ensureOutputDirectory(options.output);
    yield* fileSystem
      .copy(options.overlay, options.output, { overwrite: true })
      .pipe(
        Effect.mapError(() =>
          bootstrapError("bootstrap overlay cannot be copied"),
        ),
      );
    yield* Effect.forEach(files, (file) => placeFile(options.output, file), {
      concurrency: 1,
    });
  }).pipe(Effect.withSpan("materializeBootstrap"));
}

function isBootstrapFlag(flag: string): flag is BootstrapFlag {
  return CLI_FLAGS.some((known) => known === flag);
}

function requiredFlag(
  values: ReadonlyMap<string, string>,
  flag: BootstrapFlag,
): Effect.Effect<string, BootstrapError> {
  const value = values.get(flag);
  return value === undefined
    ? reject(`missing bootstrap CLI flag ${flag}`)
    : Effect.succeed(value);
}

function parseArguments(
  args: readonly string[],
): Effect.Effect<BootstrapMaterializationOptions, BootstrapError> {
  return Effect.gen(function* () {
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (flag === undefined || value === undefined || !flag.startsWith("--")) {
        return yield* reject("bootstrap CLI expects flag-value pairs");
      }
      if (!isBootstrapFlag(flag)) {
        return yield* reject(`unknown bootstrap CLI flag ${flag}`);
      }
      if (values.has(flag)) {
        return yield* reject(`duplicate bootstrap CLI flag ${flag}`);
      }
      values.set(flag, value);
    }

    const manifest = yield* requiredFlag(values, "--manifest");
    const source = yield* requiredFlag(values, "--source");
    const output = yield* requiredFlag(values, "--output");
    const overlay = yield* requiredFlag(values, "--overlay");
    return { manifest, source, output, overlay };
  });
}

function runCli(
  args: readonly string[],
): Effect.Effect<void, BootstrapError, FileSystem.FileSystem> {
  return parseArguments(args).pipe(Effect.flatMap(materializeBootstrap));
}

function realPath(path: string): string | undefined {
  return existsSync(path) ? realpathSync(path) : undefined;
}

/**
 * Whether this module is the process entry point rather than an import.
 *
 * Node resolves a module's real path before it becomes `import.meta.url`, while
 * `process.argv[1]` is whatever the caller typed. The controller image reaches
 * this file through `/opt/moltzap/dist`, a symlink into the installed package,
 * so an uncanonicalized comparison makes the init container look like an
 * import and exit successfully having materialized nothing.
 *
 * This repeats `cluster/entry.ts` rather than importing it: the CLI is executed
 * as TypeScript through a symlink by its own regression test, and Node resolves
 * neither a `.js` specifier to a `.ts` file nor a relative import from the
 * symlink's location.
 *
 * @param invoked Path the process was started with, if it has one.
 * @returns Whether both locations name the same real file.
 */
function isDirectInvocation(invoked?: string): boolean {
  if (invoked === undefined || invoked.length === 0) {
    return false;
  }
  const entry = realPath(resolve(invoked));
  return (
    entry !== undefined && entry === realPath(fileURLToPath(import.meta.url))
  );
}

/**
 * Report a materialization failure to the Pod log.
 *
 * The line is deliberately sanitized: mount layout and manifest detail stay in
 * the typed error channel, where only a programmatic caller reads them.
 * @returns Completion after the diagnostic has been written.
 */
function reportFailure(): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stderr.write("bootstrap materialization failed\n");
  });
}

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The executable boundary reads argv once before entering Effect.
const [, invokedPath, ...commandLine] = process.argv;

if (isDirectInvocation(invokedPath)) {
  runCli(commandLine).pipe(
    Effect.tapError(reportFailure),
    Effect.provide(NodeFileSystem.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
