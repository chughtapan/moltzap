/**
 * @file Body of coverage path 24a (CRITICAL): the cc-judge entry point
 * still loads. The Appendix D fixture
 * `packages/evals/scenarios/EVAL-005.yaml` is read byte-unchanged, its
 * payload goes through the compat adapter's `load`, and the plan and
 * coordinator cc-judge expects come back. No model executes here; the
 * executed half of path 24 is 24b, nightly.
 *
 * Two things this file deliberately does not do. It does not parse YAML
 * with a library — the package depends on none, and the fixture reader
 * below refuses anything outside the scalar mapping this fixture uses,
 * so a fixture that changes shape fails the path instead of passing
 * quietly. And it loads the adapter from source rather than from
 * `dist/`, asserting separately that the fixture's module path mirrors
 * that source file, so the path does not depend on build order.
 */
/* eslint-disable agent-code-guard/require-span-on-exported-effect -- exported path bodies run under vitest only; spans would be dead weight in the inventory runs */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Either } from "effect";
import { expect } from "vitest";
import traceCaptureHarness from "../../trace-capture-harness.js";
import { InvalidPayload } from "../../trace-capture-payload.js";

const packageRoot = dirname(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
);
const scenarioDir = join(dirname(packageRoot), "evals", "scenarios");
const fixturePath = join(scenarioDir, "EVAL-005.yaml");
const distEntry = join(packageRoot, "dist", "trace-capture-harness.js");
const sourceEntry = join(packageRoot, "src", "trace-capture-harness.ts");

const TARGET_AGENT_NAME = "openclaw-eval-agent";
const HARNESS_NAME = "moltzap-trace-capture";

type Scalars = Readonly<Record<string, string>>;

/**
 * The `key: value` pairs directly under `path` in a YAML document,
 * located by indentation. Deeper levels are not visited, so the caller
 * names every level it reads; a list item at the level being read
 * throws, because this reader cannot represent one and silence would
 * hide the fixture changing shape.
 */
function scalarsAt(text: string, path: ReadonlyArray<string>): Scalars {
  const lines = text.split("\n");
  let index = 0;
  for (const key of path) {
    const found = lines.findIndex(
      (line, at) => at >= index && line.trim().startsWith(`${key}:`),
    );
    if (found === -1) throw new Error(`fixture has no "${path.join(".")}"`);
    index = found + 1;
  }
  return collect(lines, index);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function collect(lines: ReadonlyArray<string>, from: number): Scalars {
  const entries = levelLines(lines, from, indentOf(lines[from] ?? "")).map(
    entryOf,
  );
  return Object.fromEntries(entries.filter(([, value]) => value.length > 0));
}

/** Lines at exactly `indent`, stopping where the section dedents. */
function levelLines(
  lines: ReadonlyArray<string>,
  from: number,
  indent: number,
): ReadonlyArray<string> {
  const dedent = lines.findIndex(
    (line, at) =>
      at >= from && line.trim().length > 0 && indentOf(line) < indent,
  );
  const section = dedent === -1 ? lines.slice(from) : lines.slice(from, dedent);
  return section.filter(
    (line) => line.trim().length > 0 && indentOf(line) === indent,
  );
}

function entryOf(line: string): readonly [string, string] {
  if (line.trim().startsWith("- ")) {
    throw new Error(
      `fixture line "${line.trim()}" is a list this reader cannot represent`,
    );
  }
  const [key, ...rest] = line.trim().split(": ");
  return [(key ?? "").replace(/:$/u, ""), rest.join(": ")];
}

function scalar(scalars: Scalars, key: string): string {
  const value = scalars[key];
  if (value === undefined) {
    throw new Error(`fixture has no scalar "${key}" at the level read`);
  }
  return value;
}

function readFixture(): Effect.Effect<string, unknown, never> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(fixturePath)),
    Effect.provide(NodeContext.layer),
  );
}

function fileExists(path: string): Effect.Effect<boolean, unknown, never> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(path)),
    Effect.provide(NodeContext.layer),
  );
}

function planFor(scenario: Scalars) {
  return {
    project: scalar(scenario, "project"),
    scenarioId: scalar(scenario, "scenarioId"),
    name: scalar(scenario, "name"),
    description: scalar(scenario, "description"),
    requirements: {},
  };
}

/** The module path cc-judge imports is this package's built entry point. */
function expectEntryPoint(
  fixture: string,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    expect(
      resolve(scenarioDir, scalar(scalarsAt(fixture, ["harness"]), "module")),
    ).toBe(distEntry);
    // The built file is this path's subject compiled, so asserting the
    // mirrored source keeps the check independent of build order.
    expect(yield* fileExists(sourceEntry)).toBe(true);
  });
}

function expectAssembledPlan(
  fixture: string,
): Effect.Effect<void, unknown, never> {
  const scenario = scalarsAt(fixture, []);
  return Effect.gen(function* () {
    const loaded = yield* traceCaptureHarness.load({
      sourcePath: fixturePath,
      plan: planFor(scenario),
      payload: {
        runtime: scalarsAt(fixture, ["harness", "payload", "runtime"]),
        conversation: scalarsAt(fixture, [
          "harness",
          "payload",
          "conversation",
        ]),
      },
    });
    expect(loaded.plan).toMatchObject({
      scenarioId: scalar(scenario, "scenarioId"),
      name: scalar(scenario, "name"),
      metadata: {
        harness: HARNESS_NAME,
        conversationKind: "direct",
        runtimeKind: "openclaw",
      },
    });
    expect(loaded.plan.agents).toHaveLength(1);
    expect(loaded.plan.agents[0]).toMatchObject({
      role: "target",
      name: TARGET_AGENT_NAME,
    });
    expect(loaded.coordinator.execute).toBeInstanceOf(Function);
  });
}

/** A payload outside the scenario grammar fails the load rather than reaching a run. */
function expectRejectedPayload(): Effect.Effect<void, unknown, never> {
  return Effect.either(
    traceCaptureHarness.load({
      sourcePath: fixturePath,
      plan: {
        project: "moltzap",
        scenarioId: "EVAL-000",
        name: "invalid",
        description: "invalid",
        requirements: {},
      },
      payload: { runtime: { kind: "nope" }, conversation: {} },
    }),
  ).pipe(
    Effect.map(
      Either.match({
        onLeft: (failure) => {
          expect(failure.cause).toBeInstanceOf(InvalidPayload);
        },
        onRight: () => {
          expect.unreachable("a payload outside the grammar must not load");
        },
      }),
    ),
  );
}

/** Path 24a: the entry point loads the fixture and assembles its plan. */
export function path24a(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const fixture = yield* readFixture();
    yield* expectEntryPoint(fixture);
    yield* expectAssembledPlan(fixture);
    yield* expectRejectedPayload();
  });
}
