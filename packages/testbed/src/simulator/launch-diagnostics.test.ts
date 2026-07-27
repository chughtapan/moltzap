/**
 * @file What a launch failure tells an operator about the child. The
 * runtime buffers everything the agent process printed; a readiness
 * outcome carries none of it. These assertions pin the join: the failure
 * an operator reads names the child's own last words, bounded so a
 * chatty runtime cannot turn one error into a log dump.
 */
import { describe, expect, it } from "vitest";
import { Effect, FastCheck as fc, Schema } from "effect";
import { CHILD_OUTPUT_TAIL_CHARS, readyOrFail } from "./launcher-live.js";
import { AgentName } from "./run-spec.js";
import type { AgentLaunchFailed } from "./errors.js";
import type { ReadyOutcome, Runtime } from "../runtime.js";

const SLOT = Schema.decodeSync(AgentName)("openclaw-one");
const READY_TIMEOUT_MS = 60_000;
const TIMED_OUT: ReadyOutcome = {
  _tag: "Timeout",
  timeoutMs: READY_TIMEOUT_MS,
};
const TIMEOUT_CAUSE: AgentLaunchFailed["cause"] = "ready-timeout";
const TIMEOUT_DETAIL = `no authenticated connection within ${String(READY_TIMEOUT_MS)}ms`;
const ATTACHED_LABEL = "; last output from the agent process:\n";

/** The one line in the fixture below that names why readiness never arrives. */
const CONNECTION_FAILURE =
  "[moltzap] connection failed: NotConnectedError: WebSocket not connected";

/**
 * What an OpenClaw gateway prints when it dials a path the server does
 * not serve: it starts, authenticates nothing, and retries. Readiness
 * observes only the silence.
 */
const RETRYING_CHILD = [
  "[gateway] http server listening (1 plugin: openclaw-channel; 4.4s)",
  "[moltzap] connecting as openclaw-one",
  "[gateway] ready",
  CONNECTION_FAILURE,
  "[moltzap] [testbed-agent] channel exited: WebSocket not connected",
  "[moltzap] [testbed-agent] auto-restart attempt 1/10 in 5s",
  "",
].join("\n");

/** Both regimes the bound separates: output that fits whole, and output that has to be cut. */
const childOutput = fc.oneof(
  fc.string({ maxLength: 400 }),
  fc.string({
    minLength: CHILD_OUTPUT_TAIL_CHARS + 1,
    maxLength: CHILD_OUTPUT_TAIL_CHARS * 3,
  }),
);

/** A runtime whose retained window holds `said` and nothing else. */
function runtimeSaying(said: string): Pick<Runtime, "getLogs"> {
  return { getLogs: () => ({ text: said, nextOffset: said.length }) };
}

function failureFrom(ready: ReadyOutcome, said: string) {
  return Effect.runSync(
    readyOrFail(SLOT, runtimeSaying(said), ready).pipe(Effect.flip),
  );
}

describe("launch failure diagnostics", () => {
  it("names the child's connection errors in a ready-timeout", () => {
    const failure = failureFrom(TIMED_OUT, RETRYING_CHILD);
    expect(failure.cause).toBe(TIMEOUT_CAUSE);
    expect(failure.detail).toContain(TIMEOUT_DETAIL);
    expect(failure.message).toContain(CONNECTION_FAILURE);
  });

  it("reads exactly as the timeout alone when the child said nothing", () => {
    const failure = failureFrom(TIMED_OUT, "");
    expect(failure.detail).toBe(TIMEOUT_DETAIL);
    expect(failure.message.endsWith(TIMEOUT_DETAIL)).toBe(true);
  });

  it("keeps the readiness outcome the discriminator, not the output", () => {
    expect(
      Effect.runSync(
        readyOrFail(SLOT, runtimeSaying(RETRYING_CHILD), {
          _tag: "Ready",
        }),
      ),
    ).toBeUndefined();
  });

  it("attaches a bounded suffix of whatever the child said", () => {
    fc.assert(
      fc.property(childOutput, (said) => {
        const detail = failureFrom(TIMED_OUT, said).detail;
        expect(detail.startsWith(TIMEOUT_DETAIL)).toBe(true);
        expect(detail.length).toBeLessThanOrEqual(
          TIMEOUT_DETAIL.length +
            ATTACHED_LABEL.length +
            CHILD_OUTPUT_TAIL_CHARS,
        );
        const attached = detail.slice(TIMEOUT_DETAIL.length);
        if (attached.length === 0) {
          expect(said.trim()).toBe("");
          return;
        }
        expect(attached.startsWith(ATTACHED_LABEL)).toBe(true);
        expect(
          said.trimEnd().endsWith(attached.slice(ATTACHED_LABEL.length)),
        ).toBe(true);
      }),
    );
  });
});
