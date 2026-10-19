/** @file Operator feedback through the installed process interface. */

import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const binary = fileURLToPath(
  new URL("../../../bin/moltzap-router", import.meta.url),
);
const processName = "moltzap-router";
const requiredVariable = "MOLTZAP_ROUTER_PORT";
const defaultEntry = 'MOLTZAP_ROUTER_HOST: optional; default: "127.0.0.1"';
const secret = "not a valid secret-value";
const invalidVariable = "MOLTZAP_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY";

/** An empty environment makes missing-variable behavior independent of the test runner. */
function runProcess(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) {
  return Effect.gen(function* () {
    const child = yield* Command.start(
      Command.make(
        "env",
        "-i",
        `PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
        ...Object.entries(environment).map(
          ([name, value]) => `${name}=${value}`,
        ),
        process.execPath,
        binary,
        ...arguments_,
      ),
    );
    return yield* Effect.all(
      {
        exitCode: child.exitCode,
        stdout: Stream.decodeText(child.stdout).pipe(
          Stream.runFold("", (output, chunk) => output + chunk),
        ),
        stderr: Stream.decodeText(child.stderr).pipe(
          Stream.runFold("", (output, chunk) => output + chunk),
        ),
      },
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.timeout("10 seconds"), Effect.provide(NodeContext.layer));
}

it(
  "prints environment requirements and defaults without starting",
  () =>
    Effect.gen(function* () {
      const result = yield* runProcess(["--help"], {
        [invalidVariable]: "invalid-secret",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Usage: ${processName} [--help]`);
      expect(result.stdout).toContain(
        `${requiredVariable}: required; default: none`,
      );
      expect(result.stdout).toContain(defaultEntry);
      expect(result.stdout).not.toContain("invalid-secret");
      expect(result.stdout).not.toContain("listening on");
      expect(result.stderr).toBe("");
    }),
  15_000,
);

it(
  "names missing environment variables and exits unsuccessfully",
  () =>
    Effect.gen(function* () {
      const result = yield* runProcess([]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`${requiredVariable} is required`);
      expect(result.stdout).not.toContain("listening on");
    }),
  15_000,
);

it(
  "reports invalid configuration without echoing supplied values",
  () =>
    Effect.gen(function* () {
      const result = yield* runProcess([], { [invalidVariable]: secret });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`${invalidVariable} must satisfy`);
      expect(result.stderr + result.stdout).not.toContain(secret);
      expect(result.stdout).not.toContain("listening on");
    }),
  15_000,
);

const registryKey =
  '{"crv":"Ed25519","kty":"OKP","x":"y1j1FUgbqjCPeQVEnllv-2euwn_s9DeDkfEh3gk_OJ0"}';
const fitFailures = [
  [
    "MOLTZAP_ROUTER_RETAINED_MESSAGE_BYTE_CAPACITY",
    "1",
    "retain one maximum-size message",
  ],
  [
    "MOLTZAP_ROUTER_POLL_RESPONSE_BYTE_LIMIT",
    "1",
    "return one maximum-size message",
  ],
  [
    "MOLTZAP_ROUTER_HELD_POLL_CAPACITY",
    "512",
    "less than MOLTZAP_ROUTER_REQUEST_CONCURRENCY_LIMIT",
  ],
] as const;

for (const [name, value, reason] of fitFailures) {
  it(
    `explains the resource relationship for ${name}`,
    () =>
      Effect.gen(function* () {
        const result = yield* runProcess([], {
          MOLTZAP_ROUTER_PORT: "4320",
          MOLTZAP_ROUTER_REGISTRY_ORIGIN: "http://127.0.0.1:4321",
          MOLTZAP_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY: registryKey,
          [name]: value,
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(name);
        expect(result.stderr).toContain(reason);
        expect(result.stdout).not.toContain("listening on");
      }),
    15_000,
  );
}
