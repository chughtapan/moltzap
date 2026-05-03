import { Config, ConfigProvider, Data, Effect, Option } from "effect";

export class ConformanceEnvError extends Data.TaggedError(
  "ConformanceEnvError",
)<{
  readonly key: string;
  readonly message: string;
}> {}

const ConformanceNumRuns = Config.option(Config.string("CONFORMANCE_NUM_RUNS"));
const ConformanceArtifactDir = Config.all({
  artifactDir: Config.option(Config.string("ARTIFACT_DIR")),
  conformanceArtifactDir: Config.option(
    Config.string("CONFORMANCE_ARTIFACT_DIR"),
  ),
});

export function conformanceNumRunsFromEnv(): number | undefined {
  const raw = Option.getOrUndefined(
    Effect.runSync(
      ConformanceNumRuns.pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    ),
  );
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConformanceEnvError({
      key: "CONFORMANCE_NUM_RUNS",
      message: `CONFORMANCE_NUM_RUNS must be a positive integer: ${raw}`,
    });
  }
  return parsed;
}

export function conformanceArtifactDirFromEnv(): string | undefined {
  const env = Effect.runSync(
    ConformanceArtifactDir.pipe(
      Effect.withConfigProvider(ConfigProvider.fromEnv()),
    ),
  );
  return (
    Option.getOrUndefined(env.conformanceArtifactDir) ??
    Option.getOrUndefined(env.artifactDir)
  );
}
