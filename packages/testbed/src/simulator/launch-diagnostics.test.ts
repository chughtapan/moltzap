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
import type { Secrets } from "./recording.js";
import type { ReadyOutcome, Runtime } from "../runtime.js";

const SLOT = Schema.decodeSync(AgentName)("openclaw-one");
const READY_TIMEOUT_MS = 60_000;
const TIMED_OUT: ReadyOutcome = {
  _tag: "Timeout",
  timeoutMs: READY_TIMEOUT_MS,
};
const TIMEOUT_CAUSE: AgentLaunchFailed["cause"] = "ready-timeout";
const EXITED_CAUSE: AgentLaunchFailed["cause"] = "exited-before-ready";
const TIMEOUT_DETAIL = `no authenticated connection within ${String(READY_TIMEOUT_MS)}ms`;
const ATTACHED_LABEL = "; last output from the agent process:\n";
const REDACTION_MARKER = "[REDACTED:k0]";
const NO_SECRETS: Pick<Secrets, "redact"> = { redact: (text) => text };

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

/** The run's registry replaces whole registered values; this is that rule, for one value. */
function registryHolding(secret: string): Pick<Secrets, "redact"> {
  return { redact: (text) => text.split(secret).join(REDACTION_MARKER) };
}

function failureFrom(
  ready: ReadyOutcome,
  said: string,
  secrets: Pick<Secrets, "redact"> = NO_SECRETS,
) {
  return Effect.runSync(
    readyOrFail(SLOT, runtimeSaying(said), secrets, ready).pipe(Effect.flip),
  );
}

// @agent-code-guard/regression-only: one entry per ReadyOutcome variant plus the silent-child boundary; the union is closed, so the generative evidence lives in the sibling "attached child output" scope
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

  it("carries the same tail when the child exits before ready", () => {
    const failure = failureFrom(
      { _tag: "ProcessExited", exitCode: 1, stderr: RETRYING_CHILD },
      "",
    );
    expect(failure.cause).toBe(EXITED_CAUSE);
    expect(failure.message).toContain(CONNECTION_FAILURE);
  });

  it("keeps the readiness outcome the discriminator, not the output", () => {
    expect(
      Effect.runSync(
        readyOrFail(SLOT, runtimeSaying(RETRYING_CHILD), NO_SECRETS, {
          _tag: "Ready",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("attached child output", () => {
  it("redacts before cutting, so the bound cannot split a credential", () => {
    // Sized so the cut falls inside the credential: cutting first would leave
    // `leaked` behind, and it matches no registered value, so the seal's own
    // redaction pass would not catch it.
    const secret = "sk-live-0123456789abcdef";
    const leaked = secret.slice(4);
    const trailer = "x".repeat(CHILD_OUTPUT_TAIL_CHARS - leaked.length);
    const said = `${"noise\n".repeat(200)}${secret}${trailer}`;
    const failure = failureFrom(TIMED_OUT, said, registryHolding(secret));
    expect(failure.detail).not.toContain(leaked);
    expect(failure.detail).toContain(REDACTION_MARKER);
  });

  it("is a bounded suffix of whatever the child said", () => {
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
