/** @file The harvest probe's command shape and the decoding of what it leaves. */

import { Command, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import {
  CoreV1Api,
  createConfiguration,
  type V1Status,
} from "@kubernetes/client-node";
import { Deferred, Effect, Fiber } from "effect";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarvestedFileOutcome } from "../../events/core.js";
import {
  type ApplicationFileObservation,
  applicationFileOutcome,
  ControllerStopFailed,
  execExitCode,
  execHarvestProbe,
  type ExecSession,
  type ExecSessionClient,
  harvestCommand,
  requestControllerStop,
} from "./harvest.js";

afterEach(() => vi.restoreAllMocks());

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

/**
 * `drive` plays the server's side once the session is handed out. It runs a
 * turn later than the probe's own continuation, so the probe's listeners are
 * attached before the server speaks.
 *
 * Delivering the status frame ends both output streams before the frame
 * reaches the observer, because that is what the real client does, and that
 * frame necessarily precedes the socket's close. A fake that leaves the
 * streams open models a session no client produces, and cannot reproduce
 * anything the probe does after that point.
 */
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
      const stderr = args[5];
      const status = args[8];
      const session = new FakeSocket();
      setTimeout(() => {
        if (stdout instanceof PassThrough && status !== undefined) {
          drive(session, stdout, (frame) => {
            stdout.end();
            stderr?.end();
            status(frame);
          });
        }
      }, 0);
      return Promise.resolve(session);
    },
  };
}

const READ = { namespace: "n", podName: "p", path: "/f", limitBytes: 16 };

function controllerInPhase(phase: string) {
  const core = new CoreV1Api(createConfiguration());
  const list = vi.spyOn(core, "listNamespacedPod").mockResolvedValue({
    items: [{ metadata: { name: "controller-pod" }, status: { phase } }],
  });
  return { core, list };
}

it("signals the running Pod when a terminal Pod is listed first", async () => {
  const { core, list } = controllerInPhase("Running");
  list.mockResolvedValue({
    items: [
      { metadata: { name: "old" }, status: { phase: "Failed" } },
      { metadata: { name: "running" }, status: { phase: "Running" } },
    ],
  });
  const exec = fakeExec((...[session, , status]) => {
    status({ status: "Success" });
    session.close();
  });
  const command = vi.spyOn(exec, "exec");

  await Effect.runPromise(requestControllerStop(core, exec, "run"));

  expect(command.mock.calls[0]?.[1]).toBe("running");
});

describe("requestControllerStop", () => {
  it("sends SIGTERM to PID 1 in the running controller container", async () => {
    const { core, list } = controllerInPhase("Running");
    const exec = fakeExec((...[session, , status]) => {
      status({ status: "Success" });
      session.close();
    });
    const command = vi.spyOn(exec, "exec");

    await Effect.runPromise(requestControllerStop(core, exec, "run"));

    expect(list).toHaveBeenCalledWith({
      namespace: "run",
      labelSelector: "job-name=controller",
    });
    expect(command.mock.calls[0]?.slice(0, 4)).toEqual([
      "run",
      "controller-pod",
      "controller",
      ["node", "-e", "process.kill(1,'SIGTERM')"],
    ]);
  });

  it("leaves a pending controller retryable without attempting exec", async () => {
    const { core } = controllerInPhase("Pending");
    const exec = { exec: vi.fn<ExecSessionClient["exec"]>() };

    const failure = await Effect.runPromise(
      Effect.flip(requestControllerStop(core, exec, "run")),
    );

    expect(failure).toBeInstanceOf(ControllerStopFailed);
    expect(exec.exec).not.toHaveBeenCalled();
  });

  it.each(["Succeeded", "Failed"])(
    "does not signal a %s controller",
    async (phase) => {
      const { core } = controllerInPhase(phase);
      const exec = { exec: vi.fn<ExecSessionClient["exec"]>() };

      const failure = await Effect.runPromise(
        Effect.flip(requestControllerStop(core, exec, "run")),
      );

      expect(failure).toBeInstanceOf(ControllerStopFailed);
      expect(exec.exec).not.toHaveBeenCalled();
    },
  );
});

describe("execHarvestProbe", () => {
  it("settles once the client has ended both streams and closed", async () => {
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
    const ready = await Effect.runPromise(Deferred.make<FakeSession>());
    const exec = fakeExec((session) => {
      Deferred.unsafeDone(ready, Effect.succeed(session));
    });
    const closed = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(execHarvestProbe(exec, READ));
        const session = yield* Deferred.await(ready);
        yield* Fiber.interrupt(fiber);
        return session.closed();
      }),
    );
    expect(closed).toBe(true);
  });
});

/** Execute the exact generated chunk probe against a real local binary file. */
function readLocalChunk(path: string, offset: number, limitBytes: number) {
  return Effect.gen(function* () {
    const exec = fakeExec((...[session, , status]) => {
      status({ status: "Success" });
      session.close();
    });
    const capture = vi.spyOn(exec, "exec");
    yield* execHarvestProbe(exec, { ...READ, path, limitBytes, mode: offset });
    const command = capture.mock.calls[0]?.[3];
    if (!Array.isArray(command) || command[0] === undefined) {
      return yield* Effect.dieMessage("No chunk probe command was generated");
    }
    return yield* Command.string(Command.make(command[0], ...command.slice(1)));
  });
}

it("retains binary bytes across MiB chunks and a short final chunk", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const path = `${root}/native.log`;
        const expected = Buffer.alloc(8 * 1024 * 1024 + 17);
        for (let index = 0; index < expected.length; index++) {
          expected[index] = index % 251;
        }
        yield* fs.writeFile(path, expected);
        const chunks: Buffer[] = [];
        let offset = 0;
        const limit = 4 * Math.ceil((1024 * 1024) / 3);
        for (let reads = 0; reads < 12; reads++) {
          const encoded = yield* readLocalChunk(path, offset, limit);
          expect(encoded.length).toBeLessThanOrEqual(limit);
          const chunk = Buffer.from(encoded, "base64");
          if (chunk.length === 0) {
            break;
          }
          chunks.push(chunk);
          offset += chunk.length;
        }
        expect(chunks).toHaveLength(9);
        expect(Buffer.concat(chunks).equals(expected)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeContext.layer)),
  );
});
