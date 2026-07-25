/**
 * @file Registered StubRuntime behavior scripts referenced by name from
 * `StubConfig.script`. Instrument fixtures, not scenario logic: they
 * live behind demo/test entry points and every StubRuntime society is
 * bannered as scripted.
 *
 * The registry is a closed set rather than something entry points
 * register into at import time. A mutable script registry would make a
 * spec's meaning depend on which modules happened to load first, and a
 * spec whose meaning is load-order-dependent is not reproducible.
 */
import { StubScript } from "./stub-runtime.js";

const QUIET = new StubScript({
  name: "quiet",
  steps: [],
});

/** The demo's questioner: opens with a question, then signals completion. */
const DEMO_ASKER = new StubScript({
  name: "demo-asker",
  steps: [
    {
      _tag: "send",
      to: "responder",
      content: "Are you still reachable?",
      afterMs: 500,
    },
    { _tag: "signalDone", afterMs: 12_000 },
  ],
});

/** The demo's counterpart: answers whenever it can hear the question. */
const DEMO_RESPONDER = new StubScript({
  name: "demo-responder",
  steps: [
    {
      _tag: "replyOnMatch",
      pattern: "reachable",
      content: "Still here.",
    },
  ],
});

const STUB_SCRIPTS: ReadonlyMap<string, StubScript> = new Map(
  [QUIET, DEMO_ASKER, DEMO_RESPONDER].map((script) => [script.name, script]),
);

/** Resolve a registered script name; `undefined` drives the config-time rejection. */
export function resolveStubScript(name: string): StubScript | undefined {
  return STUB_SCRIPTS.get(name);
}

/** Registered names, for fail-fast error messages. */
export function registeredStubScriptNames(): ReadonlyArray<string> {
  return [...STUB_SCRIPTS.keys()];
}
