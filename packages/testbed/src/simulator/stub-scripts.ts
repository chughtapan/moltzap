/**
 * @file Registered StubRuntime behavior scripts referenced by name from
 * `StubConfig.script`. Instrument fixtures, not scenario logic: they
 * live behind demo/test entry points and every StubRuntime society is
 * bannered as scripted. The registry is the closed v0 set; the demo
 * entry point extends it with its fault-theater scripts.
 */
import { StubScript } from "./stub-runtime.js";

const QUIET = new StubScript({
  name: "quiet",
  steps: [],
});

const STUB_SCRIPTS: ReadonlyMap<string, StubScript> = new Map(
  [QUIET].map((script) => [script.name, script]),
);

/** Resolve a registered script name; `undefined` drives the config-time rejection. */
export function resolveStubScript(name: string): StubScript | undefined {
  return STUB_SCRIPTS.get(name);
}

/** Registered names, for fail-fast error messages. */
export function registeredStubScriptNames(): ReadonlyArray<string> {
  return [...STUB_SCRIPTS.keys()];
}
