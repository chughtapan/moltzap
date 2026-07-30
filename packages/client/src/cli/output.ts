import { Effect } from "effect";

const JSON_INDENT_SPACES = 2;

const formatJson = (value: unknown): string =>
  JSON.stringify(value, null, JSON_INDENT_SPACES);

/**
 * Provides the log json runtime value.
 * @param value Value to process.
 * @returns The log json result.
 */
export const logJson = (value: unknown): Effect.Effect<void> =>
  Effect.log(formatJson(value));

/**
 * Provides the log lines runtime value.
 * @param lines Value supplied to the operation.
 * @returns The log lines result.
 */
export const logLines = (lines: Iterable<string>): Effect.Effect<void> =>
  Effect.forEach(lines, (line) => Effect.log(line), {
    concurrency: 1,
    discard: true,
  });
