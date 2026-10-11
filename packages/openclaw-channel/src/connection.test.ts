/** @file The native OpenClaw gateway reads the deployment's one grant and fails closed. */

import type * as MoltZapClient from "@moltzap/client";
import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
} from "openclaw/plugin-sdk/channel-contract";
import { scopedLive as it } from "@effect/vitest";
import { acquireHarnessEndpoint, type HarnessEndpoint } from "@moltzap/client";
import { Data, Effect, FastCheck as fc, Redacted, Stream } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Real protected files exercise the Promise-native OpenClaw credential edge.
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, vi, it as vitestIt } from "vitest";
import { createMoltzapChannelPlugin } from "./plugin.js";

// eslint-disable-next-line agent-code-guard/async-keyword -- Vitest's hoisted Promise-native mock factory runs before Effect's import binding initializes; no runtime operation or lifetime crosses this test-only boundary.
vi.mock("@moltzap/client", async (importOriginal) => ({
  ...(await importOriginal<typeof MoltZapClient>()),
  acquireHarnessEndpoint: vi.fn(),
}));

const endpoint: HarnessEndpoint = {
  send: () => Effect.succeed({}),
  messages: Stream.empty,
};
const MCP_URL = "http://127.0.0.1:4319/mcp";
const GRANT = "openclaw-runtime-credential-00000001";
const MISSING_FILENAME = "private-path-should-not-leak.txt";
class FileFixtureError extends Data.TaggedError("FileFixtureError")<{
  readonly detail: string;
}> {}

beforeEach(() => {
  vi.mocked(acquireHarnessEndpoint).mockReset();
  vi.mocked(acquireHarnessEndpoint).mockImplementation(() =>
    Effect.succeed(endpoint),
  );
  vi.stubEnv("MOLTZAP_MCP_URL", MCP_URL);
  vi.stubEnv("MOLTZAP_MCP_CREDENTIAL_FILE", undefined);
});

describe("OpenClaw configured endpoint", () => {
  it(
    "preserves trusted-local acquisition only when the grant-file setting is absent",
    preservesTrustedLocal,
  );
  it("passes the protected file's exact grant to Client", readsProtectedGrant);
  it("reads the file again for a replacement native connection", reloadsGrant);
  it(
    "rejects an empty configured path before contacting Client",
    rejectsEmptyPath,
  );
  it(
    "does not fall back or expose a missing configured path",
    rejectsMissingFile,
  );
  it(
    "refuses a directory where a credential file is required",
    rejectsDirectory,
  );
  vitestIt(
    "preserves generated grant bytes without exposing them in serialized options",
    () =>
      fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 32, maxLength: 128 }),
          (grant) => Effect.runPromise(Effect.scoped(readsGrant(grant))),
        ),
        { numRuns: 12 },
      ),
  );
});

function preservesTrustedLocal() {
  return configuredConnection().pipe(
    Effect.tap(() => {
      expect(acquireHarnessEndpoint).toHaveBeenCalledExactlyOnceWith(
        new URL(MCP_URL),
        {},
      );
    }),
  );
}

function readsProtectedGrant() {
  return readsGrant(GRANT);
}

function readsGrant(grant: string) {
  return Effect.gen(function* () {
    const directory = yield* temporaryDirectory();
    const file = join(directory, "runtime.txt");
    yield* writeGrant(file, grant);
    yield* configuredGrantConnection(file);
    const options = vi.mocked(acquireHarnessEndpoint).mock.calls.at(-1)?.[1];
    expect(options).toEqual({ credential: Redacted.make(grant) });
    expect(JSON.stringify(options)).not.toContain(grant);
  });
}

function reloadsGrant() {
  return Effect.gen(function* () {
    const directory = yield* temporaryDirectory();
    const file = join(directory, "runtime.txt");
    const replacement = `${GRANT}-replacement`;
    yield* writeGrant(file, GRANT);
    yield* configuredGrantConnection(file);
    yield* writeGrant(file, replacement);
    yield* configuredGrantConnection(file);
    expect(
      vi.mocked(acquireHarnessEndpoint).mock.calls.map((call) => call[1]),
    ).toEqual([
      { credential: Redacted.make(GRANT) },
      { credential: Redacted.make(replacement) },
    ]);
  });
}

function rejectsEmptyPath() {
  return configuredGrantConnection("").pipe(
    Effect.flip,
    Effect.tap(() => {
      expect(acquireHarnessEndpoint).not.toHaveBeenCalled();
    }),
  );
}

function rejectsMissingFile() {
  return Effect.gen(function* () {
    const directory = yield* temporaryDirectory();
    const file = join(directory, MISSING_FILENAME);
    const failure = yield* configuredGrantConnection(file).pipe(Effect.flip);
    expect(failure.detail).not.toContain(file);
    expect(failure.detail).not.toContain(MISSING_FILENAME);
    expect(acquireHarnessEndpoint).not.toHaveBeenCalled();
  });
}

function rejectsDirectory() {
  return Effect.gen(function* () {
    const directory = yield* temporaryDirectory();
    yield* configuredGrantConnection(directory).pipe(Effect.flip);
    expect(acquireHarnessEndpoint).not.toHaveBeenCalled();
  });
}

/** Exercise the native startup Promise boundary, rather than exporting a test-only credential helper. */
function configuredGrantConnection(file: string) {
  vi.stubEnv("MOLTZAP_MCP_CREDENTIAL_FILE", file);
  return configuredConnection();
}

function configuredConnection() {
  const start = createMoltzapChannelPlugin().gateway?.startAccount;
  if (start === undefined) {
    return Effect.dieMessage("native gateway start missing");
  }
  return Effect.tryPromise({
    try: () => start(gatewayContext()),
    catch: (cause) =>
      new FileFixtureError({
        detail:
          cause instanceof Error ? cause.message : "non-error native failure",
      }),
  });
}

function gatewayContext(): ChannelGatewayContext<{ readonly id: string }> {
  let snapshot: ChannelAccountSnapshot = { accountId: "primary" };
  const unused = (): never => {
    throw new Error("an empty endpoint cannot enter the native turn");
  };
  return {
    cfg: {},
    accountId: "primary",
    account: { id: "primary" },
    abortSignal: new AbortController().signal,
    runtime: {
      log: () => undefined,
      error: () => undefined,
      exit: () => undefined,
    },
    channelRuntime: {
      runtimeContexts: {
        register: () => ({ dispose: () => undefined }),
        get: () => undefined,
        watch: () => () => undefined,
      },
      inbound: { buildContext: unused, run: unused },
      routing: { resolveAgentRoute: unused },
    },
    getStatus: () => snapshot,
    setStatus: (next) => {
      snapshot = next;
    },
  };
}

function temporaryDirectory() {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "moltzap-openclaw-grant-")),
      catch: () =>
        new FileFixtureError({ detail: "fixture directory creation failed" }),
    }),
    (directory) =>
      Effect.tryPromise(() =>
        rm(directory, { recursive: true, force: true }),
      ).pipe(Effect.ignore),
  );
}

function writeGrant(file: string, value: string) {
  const staging = `${file}.next`;
  return Effect.tryPromise({
    try: () => writeFile(staging, value, { mode: 0o400 }),
    catch: () => new FileFixtureError({ detail: "fixture grant write failed" }),
  }).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => rename(staging, file),
        catch: () =>
          new FileFixtureError({ detail: "fixture grant publication failed" }),
      }),
    ),
  );
}
