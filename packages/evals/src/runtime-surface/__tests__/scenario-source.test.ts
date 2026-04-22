import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  loadEvalScenarioDocuments,
  stagePlannedHarnessArtifacts,
} from "../scenario-source.js";

function writeScenarioDoc(
  dir: string,
  filename: string,
  document: Record<string, unknown>,
): string {
  const target = path.join(dir, filename);
  fs.writeFileSync(target, stringifyYaml(document));
  return target;
}

describe("runtime-surface scenario source", () => {
  it("loads declarative scenario documents and stages planned-harness files", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-scenarios-"));
    const scenarioPath = writeScenarioDoc(tempDir, "direct.yaml", {
      id: "EVAL-900",
      name: "Direct message scenario",
      description: "Smoke test document",
      runtime: "openclaw",
      conversation: {
        _tag: "DirectMessage",
        setupMessage: "hello",
        followUpMessages: ["what changed?"],
      },
      expectedBehavior: "Reply coherently",
      assertions: [{ _tag: "ContainsText", text: "hello" }],
    });

    const loaded = await Effect.runPromise(
      loadEvalScenarioDocuments([scenarioPath as never]),
    );
    const staged = await Effect.runPromise(
      stagePlannedHarnessArtifacts({
        documents: loaded,
        resultsDirectory: tempDir as never,
      }),
    );

    expect(loaded).toHaveLength(1);
    expect(staged.artifacts).toHaveLength(1);
    expect(staged.executionInput._tag).toBe("SingleDocument");
    expect(fs.existsSync(staged.artifacts[0]!.plannedHarnessPath)).toBe(true);
    expect(
      fs.readFileSync(staged.artifacts[0]!.plannedHarnessPath, "utf8"),
    ).toContain("prompt-workspace");
  });

  it("rejects duplicate scenario ids across documents", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-scenarios-"));
    const baseDocument = {
      id: "EVAL-901",
      name: "Duplicate id",
      description: "dup",
      runtime: "openclaw",
      conversation: {
        _tag: "DirectMessage",
        setupMessage: "hello",
        followUpMessages: [],
      },
      expectedBehavior: "Reply coherently",
      assertions: [{ _tag: "ContainsText", text: "hello" }],
    };

    const firstPath = writeScenarioDoc(tempDir, "first.yaml", baseDocument);
    const secondPath = writeScenarioDoc(tempDir, "second.yaml", baseDocument);

    const result = await Effect.runPromise(
      Effect.either(
        loadEvalScenarioDocuments([firstPath as never, secondPath as never]),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.cause._tag).toBe("DuplicateScenarioId");
    }
  });

  it("rejects deterministic callback fields from the declarative surface", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-scenarios-"));
    const scenarioPath = writeScenarioDoc(tempDir, "callback.yaml", {
      id: "EVAL-902",
      name: "Callback rejection",
      description: "deterministic callbacks stay TS-only",
      runtime: "openclaw",
      conversation: {
        _tag: "DirectMessage",
        setupMessage: "hello",
        followUpMessages: [],
      },
      expectedBehavior: "Reply coherently",
      deterministicPassCheck: "legacy",
      assertions: [{ _tag: "ContainsText", text: "hello" }],
    });

    const result = await Effect.runPromise(
      Effect.either(loadEvalScenarioDocuments([scenarioPath as never])),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.cause).toEqual({
        _tag: "DeterministicCallbackNotSupported",
        path: scenarioPath,
        field: "deterministicPassCheck",
      });
    }
  });
});
