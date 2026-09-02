/** @file The harvest probe's command shape and the decoding of what it leaves. */

import { describe, expect, it } from "vitest";
import type { HarvestedFileOutcome } from "../../events/core.js";
import {
  type ApplicationFileObservation,
  applicationFileOutcome,
  execExitCode,
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
