/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, agent-code-guard/no-raw-throw-new-error, @typescript-eslint/no-invalid-void-type, sonarjs/expression-complexity -- This standalone init-container CLI is a Promise-native Node filesystem boundary. Validation failures terminate the initializer before customer Effects exist. */
/** @file Private runtime-bootstrap materializer used by the Sandbox initializer. */

import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_API_VERSION = "moltzap.bootstrap/v1";
const ROOT_KEYS = new Set(["apiVersion", "files"]);
const FILE_KEYS = new Set(["source", "path", "mode"]);

interface BootstrapFile {
  readonly source: string;
  readonly path: string;
  readonly mode: number;
}

interface BootstrapManifest {
  readonly apiVersion: typeof BOOTSTRAP_API_VERSION;
  readonly files: readonly BootstrapFile[];
}

/** Filesystem locations consumed by one bootstrap materialization. */
export interface BootstrapMaterializationOptions {
  readonly manifest: string;
  readonly source: string;
  readonly output: string;
  readonly overlay: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${label} has unknown key ${unknown}`);
  }
}

function sourceName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} must be one plain file name`);
  }
  return value;
}

function targetPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value
  ) {
    throw new TypeError(`${label} must be a normalized relative path`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError(`${label} must stay below the bootstrap output`);
  }
  return value;
}

function fileMode(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > 0o777
  ) {
    throw new TypeError(`${label} must contain only Unix permission bits`);
  }
  return Number(value);
}

function decodeManifest(value: unknown): BootstrapManifest {
  if (!isRecord(value)) {
    throw new TypeError("bootstrap manifest must be an object");
  }
  rejectUnknownKeys(value, ROOT_KEYS, "bootstrap manifest");
  if (value.apiVersion !== BOOTSTRAP_API_VERSION) {
    throw new TypeError(
      `bootstrap manifest apiVersion must be ${BOOTSTRAP_API_VERSION}`,
    );
  }
  if (!Array.isArray(value.files)) {
    throw new TypeError("bootstrap manifest files must be an array");
  }

  const targets = new Set<string>();
  const files = value.files.map((candidate, index): BootstrapFile => {
    const label = `bootstrap manifest files[${String(index)}]`;
    if (!isRecord(candidate)) {
      throw new TypeError(`${label} must be an object`);
    }
    rejectUnknownKeys(candidate, FILE_KEYS, label);
    const path = targetPath(candidate.path, `${label}.path`);
    if (targets.has(path)) {
      throw new TypeError(`bootstrap manifest repeats target ${path}`);
    }
    targets.add(path);
    return {
      source: sourceName(candidate.source, `${label}.source`),
      path,
      mode: fileMode(candidate.mode, `${label}.mode`),
    };
  });

  return { apiVersion: BOOTSTRAP_API_VERSION, files };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError(`${label} must be a directory`);
  }
}

async function ensureOutputDirectory(path: string): Promise<void> {
  try {
    await requireDirectory(path, "bootstrap output");
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    await mkdir(path, { recursive: true });
    await requireDirectory(path, "bootstrap output");
  }
}

async function resolveRegularSource(
  sourceRoot: string,
  source: string,
  name: string,
): Promise<string> {
  const resolved = await realpath(join(source, name));
  const projection = relative(sourceRoot, resolved);
  if (
    projection === ".." ||
    projection.startsWith(`..${sep}`) ||
    isAbsolute(projection)
  ) {
    throw new TypeError(`bootstrap source ${name} resolves outside its mount`);
  }
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError(
      `bootstrap source ${name} must resolve to a regular file`,
    );
  }
  return resolved;
}

async function ensureTargetDirectory(
  path: string,
  relativePath: string,
): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new TypeError(
        `bootstrap target parent is not a directory: ${relativePath}`,
      );
    }
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    await mkdir(path);
  }
}

async function ensureRegularDestination(
  path: string,
  relativePath: string,
): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TypeError(
        `bootstrap target is not a regular file: ${relativePath}`,
      );
    }
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function ensureTargetParent(
  output: string,
  relativePath: string,
): Promise<string> {
  const segments = relativePath.split("/");
  const filename = segments.pop();
  if (filename === undefined) {
    throw new TypeError("bootstrap target has no filename");
  }

  let parent = output;
  for (const segment of segments) {
    parent = join(parent, segment);
    await ensureTargetDirectory(parent, relativePath);
  }

  const destination = join(parent, filename);
  await ensureRegularDestination(destination, relativePath);
  return destination;
}

/**
 * Copy the application overlay and then materialize its run-scoped files.
 * @param options Trusted mount and output paths owned by the initializer.
 * @returns A promise that completes after every file has its declared mode.
 */
export async function materializeBootstrap(
  options: BootstrapMaterializationOptions,
): Promise<void> {
  const encoded = await readFile(options.manifest, "utf8");
  const parsed: unknown = JSON.parse(encoded);
  const manifest = decodeManifest(parsed);

  await requireDirectory(options.source, "bootstrap source");
  await requireDirectory(options.overlay, "bootstrap overlay");
  const sourceRoot = await realpath(options.source);
  const files = await Promise.all(
    manifest.files.map(async (file) => ({
      ...file,
      resolvedSource: await resolveRegularSource(
        sourceRoot,
        options.source,
        file.source,
      ),
    })),
  );

  await ensureOutputDirectory(options.output);
  await cp(options.overlay, options.output, { recursive: true });
  for (const file of files) {
    const destination = await ensureTargetParent(options.output, file.path);
    await copyFile(file.resolvedSource, destination);
    await chmod(destination, file.mode);
  }
}

function parseArguments(
  args: readonly string[],
): BootstrapMaterializationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new TypeError("bootstrap CLI expects flag-value pairs");
    }
    if (!["--manifest", "--source", "--output", "--overlay"].includes(flag)) {
      throw new TypeError(`unknown bootstrap CLI flag ${flag}`);
    }
    if (values.has(flag)) {
      throw new TypeError(`duplicate bootstrap CLI flag ${flag}`);
    }
    values.set(flag, value);
  }

  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) {
      throw new TypeError(`missing bootstrap CLI flag ${flag}`);
    }
    return value;
  };
  return {
    manifest: required("--manifest"),
    source: required("--source"),
    output: required("--output"),
    overlay: required("--overlay"),
  };
}

function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  return (
    invoked !== undefined &&
    realpathSync(resolve(invoked)) ===
      realpathSync(fileURLToPath(import.meta.url))
  );
}

async function runCli(): Promise<void> {
  await materializeBootstrap(parseArguments(process.argv.slice(2)));
}

if (isDirectInvocation()) {
  void runCli().catch(() => {
    process.stderr.write("bootstrap materialization failed\n");
    process.exitCode = 1;
  });
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, agent-code-guard/no-raw-throw-new-error, @typescript-eslint/no-invalid-void-type, sonarjs/expression-complexity -- Restore strict defaults after the standalone CLI boundary. */
