import { Effect } from "effect";

export const logInfo = (
  message: string,
  annotations: Record<string, unknown> = {},
): Effect.Effect<void> =>
  Effect.logInfo(message).pipe(Effect.annotateLogs(annotations));

export const logWarning = (
  message: string,
  annotations: Record<string, unknown> = {},
): Effect.Effect<void> =>
  Effect.logWarning(message).pipe(Effect.annotateLogs(annotations));

export const logError = (
  message: string,
  annotations: Record<string, unknown> = {},
): Effect.Effect<void> =>
  Effect.logError(message).pipe(Effect.annotateLogs(annotations));
