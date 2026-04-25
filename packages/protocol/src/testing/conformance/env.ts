export function conformanceNumRunsFromEnv(): number | undefined {
  const raw = process.env.CONFORMANCE_NUM_RUNS;
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`CONFORMANCE_NUM_RUNS must be a positive integer: ${raw}`);
  }
  return parsed;
}

export function conformanceArtifactDirFromEnv(): string | undefined {
  return process.env.CONFORMANCE_ARTIFACT_DIR ?? process.env.ARTIFACT_DIR;
}
