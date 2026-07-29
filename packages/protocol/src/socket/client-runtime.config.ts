/**
 * @file Logger policy for the managed runtime owned by each protocol client.
 * Client diagnostics use stderr so applications can reserve stdout for
 * structured output.
 */
import { Logger } from "effect";

/** @internal */
export const clientRuntimeLoggerLayer = Logger.replace(
  Logger.defaultLogger,
  Logger.withConsoleError(Logger.stringLogger),
);
