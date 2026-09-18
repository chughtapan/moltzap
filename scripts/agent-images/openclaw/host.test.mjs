/** @file The OpenClaw host wrapper binds the token profile before the gateway and fails closed. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HOST = fileURLToPath(new URL("./host.sh", import.meta.url));
/** The wrapper finds `node` on PATH, so the tests put this process's own first. */
const PATH_WITH_NODE = [dirname(process.execPath), process.env.PATH ?? ""].join(
  delimiter,
);
const PLAN = "/var/run/moltzap/bootstrap/secrets-plan.json";
const APPLY_INVOCATION = ["secrets", "apply", "--from", PLAN];
const GATEWAY_INVOCATION = [
  "gateway",
  "run",
  "--allow-unconfigured",
  "--port",
  "18789",
];
const APPLY_FAILURE_EXIT_CODE = 3;
/** Unlike 128 plus any signal number, so it can only be the gateway's own exit. */
const GATEWAY_OWN_EXIT_CODE = 42;
const KILLED_EXIT_CODE = 128 + constants.signals.SIGKILL;

/**
 * Stand in for `/app/openclaw.mjs`: append every invocation's arguments to a
 * record, then behave as `apply` and `gateway` say. `fail` exits nonzero,
 * `die` ends the process with an untrappable signal so the wrapper sees no
 * exit code, and `wait` records the signal the gateway receives and the pid
 * that received it before exiting with its own code. Signal handlers are
 * installed before the first record line, so a test that signals once that
 * line exists never reaches a fake that would die of the signal instead.
 * @param {{ apply?: "ok" | "fail" | "die", gateway?: "ok" | "wait" }} options Fake behaviour.
 * @returns {Promise<{ entry: string, record: string }>} Paths of the fake entry and its record.
 */
async function fakeOpenClaw(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "moltzap-openclaw-host-"));
  const entry = join(root, "openclaw.mjs");
  const record = join(root, "record.ndjson");
  const behaviour = {
    ok: "process.exit(0);",
    fail: `process.exit(${String(APPLY_FAILURE_EXIT_CODE)});`,
    die: 'process.kill(process.pid, "SIGKILL"); await new Promise(() => {});',
    wait: [
      "const keepAlive = setInterval(() => {}, 1000);",
      "const signal = await signalled;",
      "clearInterval(keepAlive);",
      'await appendFile(record, JSON.stringify({ signal, pid: process.pid }) + "\\n");',
      `process.exit(${String(GATEWAY_OWN_EXIT_CODE)});`,
    ].join("\n"),
  };
  await writeFile(
    entry,
    [
      "#!/usr/bin/env node",
      'import { appendFile } from "node:fs/promises";',
      'const signalled = new Promise((resolve) => { for (const name of ["SIGTERM", "SIGINT"]) process.once(name, () => resolve(name)); });',
      `const record = ${JSON.stringify(record)};`,
      'await appendFile(record, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'if (process.argv[2] === "secrets") {',
      behaviour[options.apply ?? "ok"],
      "}",
      behaviour[options.gateway ?? "ok"],
    ].join("\n"),
  );
  await chmod(entry, 0o755);
  return { entry, record };
}

/**
 * @param {Record<string, string>} environment Extra environment for the wrapper.
 * @param {(child: import("node:child_process").ChildProcess) => void} [onStart] Hook to signal the wrapper.
 * @returns {Promise<{ pid: number | undefined, code: number | null, signal: NodeJS.Signals | null, stderr: string }>} The wrapper's pid, how it ended, and what it wrote to stderr.
 */
function runHost(environment, onStart) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [HOST], {
      env: { ...process.env, PATH: PATH_WITH_NODE, ...environment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ pid: child.pid, code, signal, stderr });
    });
    onStart?.(child);
  });
}

/**
 * @param {string} record Path of the fake entry's record.
 * @returns {Promise<unknown[]>} Parsed record lines, empty before the first invocation.
 */
async function invocations(record) {
  const text = await readFile(record, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Signal the wrapper exactly once, as soon as the fake entry has recorded its
 * first invocation. Interval callbacks overlap under load, so the flag, not
 * `clearInterval`, is what keeps a second signal from reaching a fake whose
 * one-shot handler is already spent. The poll ends with the wrapper, so a
 * wrapper that never reaches the fake fails its test instead of hanging it.
 * @param {string} record Path of the fake entry's record.
 * @param {NodeJS.Signals} signal Signal to deliver to the wrapper.
 * @returns {(child: import("node:child_process").ChildProcess) => void} Hook for `runHost`.
 */
function signalAfterFirstInvocation(record, signal) {
  return (child) => {
    let sent = false;
    const poll = setInterval(async () => {
      const lines = await invocations(record);
      if (lines.length > 0 && !sent) {
        sent = true;
        clearInterval(poll);
        child.kill(signal);
      }
    }, 20);
    child.once("exit", () => {
      clearInterval(poll);
    });
  };
}

test("applies the secrets plan, then runs the gateway", async () => {
  const fake = await fakeOpenClaw();
  const { code } = await runHost({
    OPENCLAW_ENTRY: fake.entry,
    OPENCLAW_SECRETS_PLAN: PLAN,
  });
  assert.equal(code, 0);
  assert.deepEqual(await invocations(fake.record), [
    APPLY_INVOCATION,
    GATEWAY_INVOCATION,
  ]);
});

test("runs only the gateway when no plan is delivered, or an empty one", async () => {
  for (const plan of [{}, { OPENCLAW_SECRETS_PLAN: "" }]) {
    const fake = await fakeOpenClaw();
    const { code } = await runHost({ OPENCLAW_ENTRY: fake.entry, ...plan });
    assert.equal(code, 0);
    assert.deepEqual(await invocations(fake.record), [GATEWAY_INVOCATION]);
  }
});

test("a failed apply ends the host with its code and never starts the gateway", async () => {
  const fake = await fakeOpenClaw({ apply: "fail" });
  const { code, stderr } = await runHost({
    OPENCLAW_ENTRY: fake.entry,
    OPENCLAW_SECRETS_PLAN: PLAN,
  });
  assert.equal(code, APPLY_FAILURE_EXIT_CODE);
  assert.match(stderr, /secrets apply exited 3; not starting the gateway/u);
  assert.deepEqual(await invocations(fake.record), [APPLY_INVOCATION]);
});

test("a signal-killed apply counts as a failed apply and never starts the gateway", async () => {
  const fake = await fakeOpenClaw({ apply: "die" });
  const { code, stderr } = await runHost({
    OPENCLAW_ENTRY: fake.entry,
    OPENCLAW_SECRETS_PLAN: PLAN,
  });
  assert.equal(code, KILLED_EXIT_CODE);
  assert.match(
    stderr,
    new RegExp(`secrets apply exited ${String(KILLED_EXIT_CODE)}`, "u"),
  );
  assert.deepEqual(await invocations(fake.record), [APPLY_INVOCATION]);
});

test("a signal sent to the host reaches the gateway at the same pid, and the gateway's exit status is the host's", async () => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const fake = await fakeOpenClaw({ gateway: "wait" });
    const { pid, code } = await runHost(
      { OPENCLAW_ENTRY: fake.entry },
      signalAfterFirstInvocation(fake.record, signal),
    );
    assert.equal(code, GATEWAY_OWN_EXIT_CODE);
    assert.deepEqual(await invocations(fake.record), [
      GATEWAY_INVOCATION,
      { signal, pid },
    ]);
  }
});

test("a missing OpenClaw entry fails the apply and the gateway alike", async () => {
  const root = await mkdtemp(join(tmpdir(), "moltzap-openclaw-host-"));
  const missing = join(root, "absent.mjs");
  const withPlan = await runHost({
    OPENCLAW_ENTRY: missing,
    OPENCLAW_SECRETS_PLAN: PLAN,
  });
  assert.equal(withPlan.code, 1);
  assert.match(
    withPlan.stderr,
    /secrets apply exited 1; not starting the gateway/u,
  );

  const withoutPlan = await runHost({ OPENCLAW_ENTRY: missing });
  assert.equal(withoutPlan.code, 1);
  assert.doesNotMatch(withoutPlan.stderr, /secrets apply exited/u);
});
