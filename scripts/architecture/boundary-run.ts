/**
 * @file Shared state and file access for the architecture boundary checks:
 * the failure list every rule appends to, the tree walkers, and the JSON
 * narrowing helpers that keep decoded manifests typed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** One check run: where the tree is, and what has failed so far. */
export interface BoundaryRun {
  readonly repo: string;
  readonly packagesRoot: string;
  readonly failures: string[];
}

/** Two name sets one rule compares, and where it compared them. */
interface SetDrift {
  /** Location prefix of the failure. */
  readonly where: string;
  /** Name of the compared set. */
  readonly what: string;
  /** Names the tree carries. */
  readonly actual: Iterable<string>;
  /** Names the contract expects. */
  readonly wanted: Iterable<string>;
}

/** A decoded JSON object whose fields are not yet narrowed. */
export type JsonObject = Readonly<Record<string, unknown>>;

/**
 * Record a failure at one line of one file.
 * @param run Run collecting the failure.
 * @param file Absolute path of the offending file.
 * @param line One-based line number.
 * @param message What the rule found.
 */
export function fail(
  run: BoundaryRun,
  file: string,
  line: number,
  message: string,
): void {
  run.failures.push(`${relativePath(run, file)}:${line}: ${message}`);
}

/**
 * Every boundary rule compares two name sets, so every one reports drift the
 * same way: what was expected, and what the tree actually carries.
 * @param run Run collecting the failure.
 * @param drift The two sets and where they were compared.
 */
export function failOnSetDrift(run: BoundaryRun, drift: SetDrift): void {
  const got = [...drift.actual].sort(compareCodeUnits);
  const expected = [...drift.wanted].sort(compareCodeUnits);
  if (got.join(" ") === expected.join(" ")) {
    return;
  }
  run.failures.push(
    `${drift.where}: ${drift.what}; expected ${listOrNone(expected)}, got ${listOrNone(got)}`,
  );
}

/**
 * The repository-relative form of an absolute path.
 * @param run Run whose repository anchors the path.
 * @param file Absolute path.
 * @returns The path relative to the repository root.
 */
export function relativePath(run: BoundaryRun, file: string): string {
  return path.relative(run.repo, file);
}

/**
 * One-based line number of a character offset.
 * @param text Source text.
 * @param index Character offset into `text`.
 * @returns The line holding that offset.
 */
export function lineAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

/**
 * Depth-first walk that returns accepted files in directory order. An entry
 * whose name is in `skipNames` is skipped whether it is a file or a
 * directory.
 * @param dir Directory to walk; a missing one yields nothing.
 * @param accept Whether a file name belongs in the result.
 * @param skipNames Entry names never visited.
 * @returns Absolute paths of the accepted files.
 */
export function walkFiles(
  dir: string,
  accept: (name: string) => boolean,
  skipNames: ReadonlySet<string>,
): readonly string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !skipNames.has(entry.name))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(full, accept, skipNames);
      }
      return entry.isFile() && accept(entry.name) ? [full] : [];
    });
}

/**
 * Read and decode a JSON file whose top level must be an object.
 * @param file Absolute path.
 * @returns The decoded object, or an empty one when the top level is not an
 * object.
 */
export function readJsonObject(file: string): JsonObject {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return isJsonObject(value) ? value : {};
}

/**
 * The object at one field, or an empty object when it is absent or not an
 * object.
 * @param source Object holding the field.
 * @param key Field name.
 * @returns The nested object.
 */
export function objectAt(source: JsonObject, key: string): JsonObject {
  const value = source[key];
  return isJsonObject(value) ? value : {};
}

/**
 * The string at one field.
 * @param source Object holding the field.
 * @param key Field name.
 * @returns The string, or undefined when absent or not a string.
 */
export function stringAt(source: JsonObject, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The string elements of the array at one field.
 * @param source Object holding the field.
 * @param key Field name.
 * @returns The string elements, in order.
 */
export function stringsAt(source: JsonObject, key: string): readonly string[] {
  return arrayAt(source, key).filter(
    (element): element is string => typeof element === "string",
  );
}

/**
 * The array at one field, or an empty array when it is absent or not an
 * array.
 * @param source Object holding the field.
 * @param key Field name.
 * @returns The array elements, not yet narrowed.
 */
export function arrayAt(source: JsonObject, key: string): readonly unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value.map((element: unknown) => element) : [];
}

/**
 * Whether a decoded JSON value is an object rather than an array or primitive.
 * @param value Decoded value.
 * @returns True for a plain JSON object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listOrNone(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

/** Code-unit order, the order `Array.prototype.sort` uses without a comparator. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
