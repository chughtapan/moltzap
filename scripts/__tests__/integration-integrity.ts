/** @file Test-integrity plants for integration fixtures and scan roots. */
import { spawnSync } from "node:child_process";

type GateAssertion = (name: string, passed: boolean, message: string) => void;
type PlantFile = (path: string, mutate: (source: string) => string) => void;

/** A missing scan root must fail rather than report a clean scan. */
export function testMissingGuardDirectory(
  test: GateAssertion,
  plantFile: PlantFile,
  restoreAllPlants: () => void,
  workspaceRoot: string,
): void {
  try {
    plantFile("scripts/code/sloppy-code-guard.sh", (source) =>
      source.replace(
        '"packages/ tests/"',
        '"packages/ tests/integration/missing-guard-root/"',
      ),
    );
    const result = spawnSync(
      "/bin/bash",
      ["scripts/code/sloppy-code-guard.sh"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
      },
    );
    test(
      "integrity guard refuses a missing directory",
      result.status === 1 &&
        result.stderr.includes(
          "Directory does not exist: tests/integration/missing-guard-root/",
        ),
      result.stdout + result.stderr,
    );
  } finally {
    restoreAllPlants();
  }
}
