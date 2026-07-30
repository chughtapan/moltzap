/** @file Best-effort client event trace persistence. */

import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Config, ConfigProvider, Effect, Option } from "effect";

const clientEventLogDir = Config.option(
  Config.string("MOLTZAP_CLIENT_EVENT_LOG_DIR"),
);

/**
 * Resolve the configured trace directory while preserving empty-as-disabled.
 * @param configProvider Source used to resolve the environment-backed config.
 * @returns A nonempty configured directory, or `undefined` when disabled.
 */
export function getClientEventLogDir(
  configProvider?: ConfigProvider.ConfigProvider,
): string | undefined {
  const provider = configProvider ?? ConfigProvider.fromEnv();
  const directory = Option.getOrUndefined(
    Effect.runSync(
      clientEventLogDir.pipe(Effect.withConfigProvider(provider)),
    ),
  );
  return directory === "" ? undefined : directory;
}

/**
 * Append one client event trace when trace persistence is configured.
 * @param record Structured event fields to persist.
 * @returns A best-effort write Effect that logs and absorbs storage failures.
 */
export function appendClientEventTrace(
  record: Record<string, unknown>,
): Effect.Effect<void> {
  const dir = getClientEventLogDir();
  if (dir === undefined) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const agentId =
      typeof record.agentId === "string" ? record.agentId : "unknown";
    const safeAgentId = /^[A-Za-z0-9_-]+$/.test(agentId) ? agentId : "unknown";
    yield* Effect.zipRight(
      fileSystem.makeDirectory(dir, { recursive: true }),
      fileSystem.writeFileString(
        path.join(dir, `client-events-${safeAgentId}.jsonl`),
        `${JSON.stringify(record)}\n`,
        { flag: "a" },
      ),
    );
  }).pipe(
    Effect.withSpan("appendClientEventTrace"),
    Effect.provide(NodeContext.layer),
    Effect.catchAll((error) =>
      Effect.logWarning("moltzap client event trace write failed", error),
    ),
  );
}
// safer-arch-ignore no-trivial-sink-file: Event-trace lifecycle is isolated to keep the public service implementation within the normative function and file-size limits.
