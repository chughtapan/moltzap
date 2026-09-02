/** @file The harvest probe's command shape and the decoding of what it leaves. */

import type { V1Status } from "@kubernetes/client-node";
import { Effect, Fiber } from "effect";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HarvestedFileOutcome } from "../../events/core.js";
import {
  type ApplicationFileObservation,
  applicationFileOutcome,
  execExitCode,
  execHarvestProbe,
  type ExecSession,
  type ExecSessionClient,
  harvestCommand,
} from "./harvest.js";

const LIMIT_BYTES = 16;
const bytes = (value: string) => new TextEncoder().encode(value);

interface OutcomeCase {
  readonly name: string;
  readonly observation: ApplicationFileObservation;
  readonly expected: HarvestedFileOutcome;
}

const OUTCOMES: readonly OutcomeCase[] = [
  {
    name: "a regular file within the bound as UTF-8 text",
    observation: { exitCode: 0, stdout: bytes("héllo"), stderr: "" },
    expected: { _tag: "text", content: "héllo", byteLength: 6 },
  },
  {
    name: "the probe's absent exit",
    observation: { exitCode: 66, stdout: bytes(""), stderr: "" },
    expected: { _tag: "absent" },
  },
  {
    name: "the probe's oversize exit with the size it printed",
    observation: { exitCode: 67, stdout: bytes(""), stderr: "4096" },
    expected: { _tag: "oversize", byteLength: 4096, limitBytes: LIMIT_BYTES },
  },
  {
    name: "output past the bound as oversize even after a clean exit",
    observation: {
      exitCode: 0,
      stdout: bytes("x".repeat(LIMIT_BYTES + 1)),
      stderr: "",
    },
    expected: {
      _tag: "oversize",
      byteLength: LIMIT_BYTES + 1,
      limitBytes: LIMIT_BYTES,
    },
  },
  {
    name: "any other exit and what the probe said as the cause",
    observation: {
      exitCode: 1,
      stdout: bytes(""),
      stderr: "sh: permission denied\n",
    },
    expected: {
      _tag: "unreadable",
      cause: "the read exited 1: sh: permission denied",
    },
  },
  {
    name: "a session that ended without a status as unreadable",
    observation: { stdout: bytes(""), stderr: "" },
    expected: {
      _tag: "unreadable",
      cause: "the read ended without an exit status",
    },
  },
  {
    name: "a status frame without an exit code by what it said",
    observation: {
      statusMessage: "container not found (application)",
      stdout: bytes(""),
      stderr: "",
    },
    expected: {
      _tag: "unreadable",
      cause:
        "the read ended without an exit status: container not found (application)",
    },
  },
];

describe("harvestCommand", () => {
  it("passes the path and the bound as data, never as shell syntax", () => {
    const path = '/var/run/moltzap/bootstrap/workspace/a b"; rm -rf ~;.md';

    const command = harvestCommand(path, 64);

    expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(command.slice(-3)).toEqual(["harvest", path, "64"]);
    expect(command[2]).not.toContain(path);
    expect(command[2]).toContain('"$1"');
    expect(command[2]).toContain('"$2"');
  });
});

describe("applicationFileOutcome", () => {
  it.each(OUTCOMES)("reads $name", ({ observation, expected }) => {
    expect(applicationFileOutcome(observation, LIMIT_BYTES)).toEqual(expected);
  });

  it("reports bytes that are not UTF-8 as unreadable", () => {
    const outcome = applicationFileOutcome(
      { exitCode: 0, stdout: Uint8Array.of(0xff, 0xfe), stderr: "" },
      LIMIT_BYTES,
    );

    expect(outcome._tag).toBe("unreadable");
    if (outcome._tag === "unreadable") {
      expect(outcome.cause).toContain("UTF-8");
    }
  });
});

describe("execExitCode", () => {
  it("reads success, a non-zero exit, and frames that carry no exit", () => {
    expect(execExitCode({ status: "Success" })).toBe(0);
    expect(
      execExitCode({
        status: "Failure",
        reason: "NonZeroExitCode",
        details: { causes: [{ reason: "ExitCode", message: "66" }] },
      }),
    ).toBe(66);
    expect(
      execExitCode({ status: "Failure", reason: "InternalError" }),
    ).toBeUndefined();
    expect(
      execExitCode({
        status: "Failure",
        reason: "NonZeroExitCode",
        details: { causes: [{ reason: "ExitCode", message: "many" }] },
      }),
    ).toBeUndefined();
  });
});

interface FakeSession extends ExecSession {
  readonly closed: () => boolean;
  readonly fail: (cause: Error) => void;
}

// One exec session with the surface the probe waits on. A real socket's
// readyState is a getter, and so is this one: a copied value would never move.
class FakeSocket extends EventEmitter implements FakeSession {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the WebSocket constant this mirrors is spelled this way.
  readonly CLOSED = 3;
  private state = 1;

  get readyState(): number {
    return this.state;
  }

  close(): void {
    this.state = 3;
    this.emit("close");
  }

  closed(): boolean {
    return this.state === 3;
  }

  fail(cause: Error): void {
    this.emit("error", cause);
  }
}

// `drive` plays the server's side once the session is handed out.
function fakeExec(
  drive: (
    session: FakeSession,
    stdout: PassThrough,
    status: (frame: V1Status) => void,
  ) => void,
): ExecSessionClient {
  return {
    exec: (...args) => {
      const stdout = args[4];
      const status = args[8];
      const session = new FakeSocket();
      // A turn later than the probe's own continuation, so its listeners are
      // attached before the server side speaks.
      setTimeout(() => {
        if (stdout instanceof PassThrough && status !== undefined) {
          drive(session, stdout, status);
        }
      }, 0);
      return Promise.resolve(session);
    },
  };
}

const READ = { namespace: "n", podName: "p", path: "/f", limitBytes: 16 };

describe("execHarvestProbe", () => {
  it("settles on close with the status frame's exit and the captured output", async () => {
    const exec = fakeExec((session, stdout, status) => {
      stdout.write("hi");
      status({ status: "Success" });
      session.close();
    });

    const observed = await Effect.runPromise(execHarvestProbe(exec, READ));

    expect(observed.exitCode).toBe(0);
    expect(Buffer.from(observed.stdout).toString()).toBe("hi");
  });

  it("keeps no more than one byte past the bound of what the container sends", async () => {
    const exec = fakeExec((session, stdout, status) => {
      stdout.write("x".repeat(READ.limitBytes * 4));
      status({ status: "Success" });
      session.close();
    });

    const observed = await Effect.runPromise(execHarvestProbe(exec, READ));

    expect(observed.stdout.byteLength).toBe(READ.limitBytes + 1);
    expect(applicationFileOutcome(observed, READ.limitBytes)._tag).toBe(
      "oversize",
    );
  });

  it("fails the session when the socket errors", async () => {
    const exec = fakeExec((session) => {
      session.fail(new Error("refused"));
    });

    const failure = await Effect.runPromise(
      Effect.flip(execHarvestProbe(exec, READ)),
    );

    expect(failure._tag).toBe("ExecSessionFailed");
  });

  it("closes the session when the read is interrupted", async () => {
    let held: FakeSession | undefined;
    const exec = fakeExec((session) => {
      held = session;
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(execHarvestProbe(exec, READ));
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(held?.closed()).toBe(true);
  });
});
