import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProcessSessionDriver,
  materializeProcessMounts,
} from "./process-driver.mjs";

function invalid(detail) {
  return Object.assign(new Error(detail), {
    kind: "spec-invalid",
    retryable: false,
    detail,
  });
}

function sessionSpec(overrides = {}) {
  return {
    key: {
      installSlug: "install",
      agentGroupId: "agent",
      sessionId: "session",
      ...overrides,
    },
    labels: {},
    containers: [
      {
        role: "agent",
        image: "unused",
        env: { SPEC_VALUE: "spec" },
        contributedEnv: { CONTRIBUTED_VALUE: "contributed" },
        command: [process.execPath],
        mounts: [],
      },
    ],
    network: "shared-private",
    hardening: "standard",
    resources: {},
    runtimeTier: "container",
    stopGraceSeconds: 1,
  };
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "moltzap-process-driver-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("runs one shared session and reports its terminal state", async (t) => {
  const root = await temporaryRoot(t);
  const calls = [];
  const child = new EventEmitter();
  child.pid = 867_530;
  child.exitCode = null;
  child.signalCode = null;
  const driver = createProcessSessionDriver({
    policy: {},
    validateSpec: () => {},
    specInvalid: invalid,
    spawn: (...args) => {
      calls.push(args);
      return child;
    },
    resolveContainerPath: (path) => join(root, "container", path),
    workingDirectory: "/workspace/agent",
    baseEnvironment: { BASE_VALUE: "base" },
  });

  const handle = await driver.prepare(sessionSpec());
  assert.strictEqual(await driver.prepare(sessionSpec()), handle);
  await handle.start();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].cwd, join(root, "container/workspace/agent"));
  assert.deepEqual(calls[0][2].env, {
    BASE_VALUE: "base",
    SPEC_VALUE: "spec",
    CONTRIBUTED_VALUE: "contributed",
  });
  assert.deepEqual(await handle.status(), { phase: "running" });

  child.exitCode = 7;
  child.emit("exit", 7, null);
  assert.deepEqual(await handle.status(), {
    phase: "failed",
    failure: { kind: "started-then-died", retryable: false, exitCode: 7 },
  });
  await assert.rejects(
    driver.prepare(sessionSpec({ sessionId: "other" })),
    /already bound/u,
  );
});

test("preserves a non-empty mount target", async (t) => {
  const root = await temporaryRoot(t);
  const source = join(root, "source");
  const target = join(root, "container/workspace");
  await Promise.all([mkdir(source), mkdir(target, { recursive: true })]);
  await writeFile(join(target, "owned.txt"), "keep");

  await assert.rejects(
    materializeProcessMounts(
      [{ hostPath: source, containerPath: "/workspace" }],
      {
        resolveContainerPath: (path) => join(root, "container", path),
        specInvalid: invalid,
      },
    ),
    /non-empty mount target/u,
  );
  assert.equal(await readFile(join(target, "owned.txt"), "utf8"), "keep");
});
