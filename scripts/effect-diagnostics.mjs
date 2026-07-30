import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "..");
const tsconfigPaths = [
  ...readdirSync(join(workspaceRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("packages", entry.name, "tsconfig.json")),
  ...readdirSync(join(workspaceRoot, "v2"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("v2", entry.name, "tsconfig.json")),
].filter((configPath) => existsSync(resolve(workspaceRoot, configPath)));

const diagnosticsByKey = new Map();
const summaries = [];
const effectTsgo = resolve(workspaceRoot, "node_modules/.bin/effect-tsgo");

for (const configPath of tsconfigPaths) {
  const result = spawnSync(
    effectTsgo,
    ["diagnostics", "--project", configPath, "--format", "json"],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  const output = result.stdout.trim();
  if (output.length === 0) {
    throw new Error(
      `effect-tsgo produced no JSON for ${configPath}: ${result.stderr}`,
    );
  }
  const report = JSON.parse(output);
  summaries.push({ config: configPath, summary: report.summary });
  for (const diagnostic of report.diagnostics) {
    const file = relative(workspaceRoot, diagnostic.file);
    const key = `${file}:${diagnostic.start}:${diagnostic.name}`;
    diagnosticsByKey.set(key, { ...diagnostic, file });
  }
}

const diagnostics = [...diagnosticsByKey.values()];
const detailed = process.argv.includes("--details");
const countBy = (selector) => {
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    const value = selector(diagnostic);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => right[1] - left[1]),
  );
};

console.log(
  JSON.stringify(
    {
      configs: summaries,
      deduplicated: {
        total: diagnostics.length,
        bySeverity: countBy((diagnostic) => diagnostic.severity),
        byRule: countBy((diagnostic) => diagnostic.name),
        byProject: countBy((diagnostic) =>
          diagnostic.file.split("/").slice(0, 2).join("/"),
        ),
      },
      ...(detailed ? { diagnostics } : {}),
    },
    null,
    2,
  ),
);
