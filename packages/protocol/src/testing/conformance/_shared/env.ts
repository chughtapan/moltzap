import { Config, ConfigProvider, Data, Effect, Option } from "effect";

/** Reports conformance env failures. */
export class ConformanceEnvError extends Data.TaggedError(
  "ConformanceEnvError",
)<{
  readonly key: string;
  readonly message: string;
}> {}

const conformanceNumRuns = Config.option(Config.string("CONFORMANCE_NUM_RUNS"));
const conformanceArtifactDirValue = Config.all({
  artifactDir: Config.option(Config.string("ARTIFACT_DIR")),
  conformanceArtifactDir: Config.option(
    Config.string("CONFORMANCE_ARTIFACT_DIR"),
  ),
});

/**
 * Executes the conformance num runs from env operation.
 * @returns The conformance num runs from env result.
 */
export function conformanceNumRunsFromEnv(): number | undefined {
  const raw = Option.getOrUndefined(
    Effect.runSync(
      conformanceNumRuns.pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    ),
  );
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConformanceEnvError({
      key: "CONFORMANCE_NUM_RUNS",
      message: `CONFORMANCE_NUM_RUNS must be a positive integer: ${raw}`,
    });
  }
  return parsed;
}

/**
 * Executes the conformance artifact dir from env operation.
 * @returns The conformance artifact dir from env result.
 */
export function conformanceArtifactDirFromEnv(): string | undefined {
  const env = Effect.runSync(
    conformanceArtifactDirValue.pipe(
      Effect.withConfigProvider(ConfigProvider.fromEnv()),
    ),
  );
  return (
    Option.getOrUndefined(env.conformanceArtifactDir) ??
    Option.getOrUndefined(env.artifactDir)
  );
}
