import { Effect } from "effect";

const JSON_INDENT_SPACES = 2;

export const logJson = (value: unknown): Effect.Effect<void> =>
  Effect.log(formatJson(value));

export const logLines = (lines: Iterable<string>): Effect.Effect<void> =>
  Effect.forEach(lines, (line) => Effect.log(line), {
    concurrency: 1,
    discard: true,
  });

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, JSON_INDENT_SPACES);
}
