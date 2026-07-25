import { Effect } from "effect";

type ErrorFactory<E> = (reason: string, cause?: unknown) => E;

/**
 * Shape guards for decoded manifests and lockfiles, bound to one module's
 * tagged-error factory so failures stay in that module's error channel. The
 * value guards throw because they run inside `Effect.try` decode blocks;
 * `requireSoleEntry` fails in the error channel because directory listings are
 * already read inside an Effect.
 */
export function makeJsonGuards<E>(makeError: ErrorFactory<E>) {
  function requireRecord(
    value: unknown,
    label: string,
  ): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
      throw makeError(`Expected ${label} to be an object`);
    }
    return value;
  }

  function requireString(value: unknown, label: string): string {
    if (typeof value !== "string") {
      throw makeError(`Expected ${label} to be a string`);
    }
    return value;
  }

  function requireExactValue(
    actual: unknown,
    expected: string,
    label: string,
  ): void {
    if (actual !== expected) {
      throw makeError(`Expected ${label} to equal ${expected}`);
    }
  }

  function requireSoleEntry(
    entries: ReadonlyArray<string>,
    label: string,
  ): Effect.Effect<string, E> {
    const [entry] = entries;
    return entry === undefined || entries.length !== 1
      ? Effect.fail(makeError(`Expected one ${label}; found ${entries.length}`))
      : Effect.succeed(entry);
  }

  return {
    isRecord,
    requireExactValue,
    requireRecord,
    requireSoleEntry,
    requireString,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
