/** @file Release admission rejects non-calendar live and retained wire versions. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoundaryRun } from "./boundary-run.ts";
import { checkWireVersionSets } from "./boundary-manifests.ts";

const emitted = "2099.101.0";

for (const scenario of [
  {
    live: [emitted, "2099.1023.1"],
    history: [emitted, "2098.1231.12"],
    invalid: [],
  },
  {
    live: [emitted, "invalid"],
    history: [emitted],
    invalid: ["LIVE_WIRE_VERSIONS"],
  },
  {
    live: [emitted],
    history: [emitted, "1.2.3"],
    invalid: ["HISTORY_WIRE_VERSIONS"],
  },
]) {
  await test(`checks calendar wire sets ${JSON.stringify(scenario)}`, () => {
    const run: BoundaryRun = {
      repo: ".",
      packagesRoot: "packages",
      failures: [],
    };
    checkWireVersionSets(run, {
      live: scenario.live,
      history: scenario.history,
    });
    assert.equal(run.failures.length, scenario.invalid.length);
    for (const name of scenario.invalid) {
      assert.ok(
        run.failures.some((failure) => failure.includes(`${name} entry`)),
      );
    }
  });
}
