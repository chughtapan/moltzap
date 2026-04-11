// Stub logger matching nanoclaw's src/logger.ts shape. Nanoclaw's real logger
// writes ANSI-colored structured output to stdout/stderr. For unit tests in this
// package, we only need a silent shape-compatible fake.

type LogInput = Record<string, unknown> | string;

function noop(_dataOrMsg: LogInput, _msg?: string): void {
  // Unit tests don't assert on log output. In a real nanoclaw install, this
  // file is not used — imports resolve against nanoclaw's own logger.ts.
}

export const logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
};
