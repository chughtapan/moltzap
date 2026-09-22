import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runAgentImage } from "./entrypoint.mjs";

const currentUserId = process.getuid?.() ?? 1_000;
const currentGroupId = process.getgid?.() ?? currentUserId;

async function executable(path, lines) {
  await writeFile(path, lines.join("\n") + "\n");
  await chmod(path, 0o755);
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "moltzap-agent-entrypoint-"));
  const source = join(root, "source");
  const runtime = join(root, "runtime");
  const state = join(root, "state");
  const hostRecord = join(root, "host.json");
  const hostStarts = join(root, "host-starts");
  const registrationStarts = join(root, "registration-starts");
  const projectedData = join(source, "..data");
  await mkdir(projectedData, { recursive: true });
  await writeFile(join(projectedData, "agent-private-key"), "private");
  await writeFile(join(projectedData, "admission-credential"), "admission");
  await symlink(
    join("..data", "agent-private-key"),
    join(source, "agent-private-key"),
  );
  await symlink(
    join("..data", "admission-credential"),
    join(source, "admission-credential"),
  );

  const daemon = join(root, "daemon.mjs");
  await executable(daemon, [
    "#!/usr/bin/env node",
    'import { writeFile } from "node:fs/promises";',
    'await writeFile(process.env.MOLTZAPD_STATE_DIRECTORY + "/daemon-env.json", JSON.stringify(process.env));',
    options.daemonExitCode === undefined
      ? 'const keepAlive = setInterval(() => {}, 1000); await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); }); clearInterval(keepAlive);'
      : `const deadline = Date.now() + 10000; while (!(await import("node:fs")).existsSync(${JSON.stringify(hostStarts)})) { if (Date.now() >= deadline) throw new Error("host did not start"); await new Promise((resolve) => setTimeout(resolve, 10)); }`,
    options.daemonExitCode === undefined
      ? "process.exitCode = 0;"
      : "process.exitCode = " + String(options.daemonExitCode) + ";",
  ]);

  const registrar = join(root, "register.mjs");
  await executable(registrar, [
    "#!/usr/bin/env node",
    'import { writeFile } from "node:fs/promises";',
    `await writeFile(${JSON.stringify(registrationStarts)}, "start");`,
    options.registrationWait === true
      ? 'const keepAlive = setInterval(() => {}, 1000); await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); }); clearInterval(keepAlive);'
      : "",
    "process.exitCode = " + String(options.registrationExitCode ?? 0) + ";",
  ]);

  const host = join(root, "host.mjs");
  await executable(host, [
    "#!/usr/bin/env node",
    'import { appendFile, writeFile } from "node:fs/promises";',
    'await appendFile(process.env.TEST_HOST_STARTS, "start\\n");',
    options.hostWait === true
      ? 'const keepAlive = setInterval(() => {}, 1000); const stopped = new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });'
      : "",
    "await writeFile(process.env.TEST_HOST_RECORD, JSON.stringify(process.env));",
    options.hostWait === true
      ? "await stopped; clearInterval(keepAlive);"
      : "await new Promise((resolve) => setTimeout(resolve, 50));",
    'process.stdout.write("final host output\\n");',
    'process.stderr.write("final host error\\n");',
    "process.exitCode = " + String(options.hostExitCode ?? 0) + ";",
  ]);
  const hostCommand = join(root, "host-command.json");
  await writeFile(hostCommand, JSON.stringify([process.execPath, host]));

  return {
    hostRecord,
    hostStarts,
    registrationStarts,
    root,
    environment: {
      ANTHROPIC_API_KEY: "model-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-subscription-secret",
      CODEX_AUTH_JSON: '{"tokens":{"access_token":"subscription-secret"}}',
      MOLTZAPD_ADMISSION_CREDENTIAL_FILE: runtime + "/admission-credential",
      MOLTZAPD_AGENT_PRIVATE_KEY_FILE: runtime + "/agent-private-key",
      MOLTZAPD_MCP_PORT: "43117",
      MOLTZAPD_REGISTRY_ORIGIN: "http://registry.invalid",
      MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY: "{}",
      MOLTZAPD_ROUTER_ORIGIN: "http://router.invalid",
      MOLTZAPD_STATE_DIRECTORY: state,
      MOLTZAP_AGENT_IMAGE_DAEMON_EXECUTABLE: daemon,
      MOLTZAP_AGENT_IMAGE_DAEMON_GID: String(currentGroupId),
      MOLTZAP_AGENT_IMAGE_DAEMON_UID: String(currentUserId),
      MOLTZAP_AGENT_IMAGE_LOG_DIRECTORY: join(root, "logs"),
      MOLTZAP_AGENT_IMAGE_HOST_COMMAND: hostCommand,
      MOLTZAP_AGENT_IMAGE_HOST_HOME: root,
      MOLTZAP_AGENT_IMAGE_HOST_GID: String(currentGroupId),
      MOLTZAP_AGENT_IMAGE_HOST_UID: String(currentUserId),
      MOLTZAP_AGENT_IMAGE_REGISTRAR: registrar,
      MOLTZAP_AGENT_IMAGE_SECRET_DIRECTORY: runtime,
      MOLTZAP_AGENT_IMAGE_SECRET_SOURCE: source,
      MOLTZAP_MCP_URL: "http://127.0.0.1:43117/mcp",
      MOLTZAP_REGISTRATION_AGENT_NAME: "alice",
      MOLTZAP_REGISTRATION_OPERATION_ID: "operation",
      MOLTZAP_REGISTRATION_PRINCIPAL_ID: "principal",
      PATH: process.env.PATH,
      TEST_HOST_RECORD: hostRecord,
      TEST_HOST_STARTS: hostStarts,
    },
    runtime,
    state,
  };
}

async function waitForPath(path, timeoutMillis = 1_000) {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("the host learns its agent name and not the registration details", async () => {
  const app = await fixture();

  assert.equal(await runAgentImage(app.environment), 0);

  const hostEnvironment = JSON.parse(await readFile(app.hostRecord, "utf8"));
  assert.equal(hostEnvironment.MOLTZAP_AGENT_NAME, "alice");
  assert.equal(hostEnvironment.MOLTZAP_REGISTRATION_AGENT_NAME, undefined);
});

test("successful bootstrap starts the host with separated credentials", async () => {
  const app = await fixture();

  assert.equal(await runAgentImage(app.environment), 0);

  const daemonEnvironment = JSON.parse(
    await readFile(join(app.state, "daemon-env.json"), "utf8"),
  );
  const hostEnvironment = JSON.parse(await readFile(app.hostRecord, "utf8"));
  assert.equal(daemonEnvironment.ANTHROPIC_API_KEY, undefined);
  assert.equal(daemonEnvironment.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(daemonEnvironment.CODEX_AUTH_JSON, undefined);
  assert.equal(hostEnvironment.ANTHROPIC_API_KEY, "model-secret");
  assert.equal(
    hostEnvironment.CLAUDE_CODE_OAUTH_TOKEN,
    "sk-ant-oat01-subscription-secret",
  );
  assert.equal(
    hostEnvironment.CODEX_AUTH_JSON,
    '{"tokens":{"access_token":"subscription-secret"}}',
  );
  assert.equal(hostEnvironment.MOLTZAPD_AGENT_PRIVATE_KEY_FILE, undefined);
  assert.equal(hostEnvironment.MOLTZAP_REGISTRATION_OPERATION_ID, undefined);
  assert.equal(
    await readFile(join(app.runtime, "agent-private-key"), "utf8"),
    "private",
  );
  assert.equal(
    (await stat(join(app.runtime, "agent-private-key"))).mode & 0o777,
    0o400,
  );
});

test("prepares the daemon's history export and keeps it from the host", async () => {
  const app = await fixture();
  const exportPath = join(app.root, "history.ndjson");

  assert.equal(
    await runAgentImage({
      ...app.environment,
      MOLTZAPD_HISTORY_EXPORT: exportPath,
    }),
    0,
  );

  const daemonEnvironment = JSON.parse(
    await readFile(join(app.state, "daemon-env.json"), "utf8"),
  );
  const hostEnvironment = JSON.parse(await readFile(app.hostRecord, "utf8"));
  assert.equal(daemonEnvironment.MOLTZAPD_HISTORY_EXPORT, exportPath);
  assert.equal(hostEnvironment.MOLTZAPD_HISTORY_EXPORT, undefined);
  const exportFile = await stat(exportPath);
  assert.equal(exportFile.mode & 0o777, 0o600);
  assert.equal(exportFile.uid, currentUserId);
  assert.equal(await readFile(exportPath, "utf8"), "");
});

test("daemon exit terminates the host and is not restarted", async () => {
  const app = await fixture({ daemonExitCode: 7, hostWait: true });

  assert.equal(await runAgentImage(app.environment), 7);
  assert.equal(await readFile(app.hostStarts, "utf8"), "start\n");
});

test("registration failure prevents the host from starting", async () => {
  const app = await fixture({ registrationExitCode: 4 });

  await assert.rejects(
    runAgentImage(app.environment),
    /daemon registration failed \(4\)/u,
  );
  await assert.rejects(readFile(app.hostStarts, "utf8"), { code: "ENOENT" });
});

test("shutdown during registration completes cleanly", async () => {
  const app = await fixture({ registrationWait: true });
  const running = runAgentImage(app.environment);
  await waitForPath(app.registrationStarts);

  process.emit("SIGTERM");

  assert.equal(await running, 0);
  await assert.rejects(readFile(app.hostStarts, "utf8"), { code: "ENOENT" });
});

test("finalization drains native logs and keeps the container available for collection", async () => {
  const app = await fixture({ hostWait: true });
  const running = runAgentImage(app.environment);
  await waitForPath(app.hostRecord);
  process.emit("SIGUSR2");
  const marker = join(app.root, "logs", "finalized.json");
  await waitForPath(marker);
  const timing = JSON.parse(await readFile(marker, "utf8"));
  assert.ok(timing.requestedAt <= timing.hostStoppedAt);
  assert.ok(timing.hostStoppedAt <= timing.flushedAt);
  assert.ok(BigInt(timing.durationNanos) > 0n);
  assert.equal(
    await readFile(join(app.root, "logs", "runtime.stdout.log"), "utf8"),
    "final host output\n",
  );
  assert.equal(
    await readFile(join(app.root, "logs", "runtime.stderr.log"), "utf8"),
    "final host error\n",
  );
  let stopped = false;
  running.then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  process.emit("SIGTERM");
  assert.equal(await running, 0);
});

/**
 * Run one image to the end: wait for the host, finalize it, then shut down.
 * @param {object} app A fixture.
 * @param {Record<string, string>} environment The container environment.
 * @returns {Promise<void>} Settled once the entrypoint has exited.
 */
async function finalizeRun(app, environment) {
  const running = runAgentImage(environment);
  await waitForPath(app.hostRecord);
  process.emit("SIGUSR2");
  await waitForPath(join(app.root, "logs", "finalized.json"), 10_000);
  process.emit("SIGTERM");
  await running;
}

/**
 * @param {object} app A fixture.
 * @param {string[]} finalizerSource Lines of the host finalizer, or none to ship no finalizer.
 * @param {Record<string, string>} [extra] Further environment.
 * @returns {Promise<string>} Path of the model-usage file after finalization.
 */
async function finalizeWithModelUsage(app, finalizerSource, extra = {}) {
  const finalizer = join(app.root, "finalize-host.mjs");
  if (finalizerSource.length > 0) await executable(finalizer, finalizerSource);
  const usage = join(app.root, "logs", "model-usage.json");
  await finalizeRun(app, {
    ...app.environment,
    MOLTZAP_AGENT_IMAGE_HOST_FINALIZER: finalizer,
    MOLTZAP_AGENT_IMAGE_MODEL_USAGE: usage,
    ...extra,
  });
  return usage;
}

const OK_SUMMARY = JSON.stringify({
  schema: "moltzap.agent-model-usage/v1",
  status: "ok",
  agents: [],
});

test("no model-usage file is written unless the run asked for one", async () => {
  const app = await fixture({ hostWait: true });
  await finalizeRun(app, app.environment);

  await assert.rejects(stat(join(app.root, "logs", "model-usage.json")), {
    code: "ENOENT",
  });
});

test("the host finalizer's summary is kept in a file only its owner can read", async () => {
  const app = await fixture({ hostWait: true });
  const usage = await finalizeWithModelUsage(app, [
    `process.stdout.write(${JSON.stringify(OK_SUMMARY)});`,
  ]);

  assert.equal(await readFile(usage, "utf8"), OK_SUMMARY);
  assert.equal((await stat(usage)).mode & 0o777, 0o600);
});

test("the host finalizer sees the host's environment and none of the daemon's", async () => {
  const app = await fixture({ hostWait: true });
  const seen = join(app.root, "finalizer-env.json");
  await finalizeWithModelUsage(app, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));`,
    `process.stdout.write(${JSON.stringify(OK_SUMMARY)});`,
  ]);

  const environment = JSON.parse(await readFile(seen, "utf8"));
  assert.equal(environment.MOLTZAPD_AGENT_PRIVATE_KEY_FILE, undefined);
  assert.equal(environment.TEST_HOST_RECORD, app.hostRecord);
});

test("a host finalizer that overruns leaves a timeout record", async () => {
  const app = await fixture({ hostWait: true });
  const usage = await finalizeWithModelUsage(
    app,
    ["await new Promise((resolve) => setTimeout(resolve, 30_000));"],
    { MOLTZAP_AGENT_IMAGE_HOST_FINALIZER_TIMEOUT_MS: "200" },
  );

  assert.equal(
    JSON.parse(await readFile(usage, "utf8")).status,
    "finalizer-timeout",
  );
});

test("a host finalizer that prints something other than a summary leaves a failure record", async () => {
  const app = await fixture({ hostWait: true });
  const usage = await finalizeWithModelUsage(app, [
    'process.stdout.write("not json");',
  ]);
  const record = JSON.parse(await readFile(usage, "utf8"));

  assert.deepEqual(
    [record.status, record.reason],
    ["finalizer-failed", "the summary is not JSON"],
  );
});

test("a summary carrying another schema leaves a failure record", async () => {
  const app = await fixture({ hostWait: true });
  const usage = await finalizeWithModelUsage(app, [
    `process.stdout.write(${JSON.stringify(JSON.stringify({ schema: "other/v1", agents: [] }))});`,
  ]);

  assert.equal(
    JSON.parse(await readFile(usage, "utf8")).reason,
    "unexpected schema",
  );
});

test("a summary is not written through a symlink left where it is staged", async () => {
  const app = await fixture({ hostWait: true });
  const decoy = join(app.root, "decoy.json");
  await writeFile(decoy, "untouched");
  await mkdir(join(app.root, "logs"), { recursive: true });
  await symlink(decoy, join(app.root, "logs", "model-usage.json.partial"));
  await finalizeWithModelUsage(app, [
    `process.stdout.write(${JSON.stringify(OK_SUMMARY)});`,
  ]);

  assert.equal(await readFile(decoy, "utf8"), "untouched");
});

test("a host finalizer that exits non-zero leaves a failure record", async () => {
  const app = await fixture({ hostWait: true });
  const usage = await finalizeWithModelUsage(app, ["process.exitCode = 3;"]);

  assert.equal(JSON.parse(await readFile(usage, "utf8")).reason, "exit code 3");
});

test("a summary over the harvest bound is refused", async () => {
  const app = await fixture({ hostWait: true });
  const usage = await finalizeWithModelUsage(app, [
    'process.stdout.write("x".repeat(2 * 1024 * 1024));',
  ]);

  assert.equal(
    JSON.parse(await readFile(usage, "utf8")).reason,
    "the summary exceeds 1 MiB",
  );
});

test("an image without a host finalizer leaves a failure record", async () => {
  const app = await fixture({ hostWait: true });
  const usage = await finalizeWithModelUsage(app, []);

  assert.equal(
    JSON.parse(await readFile(usage, "utf8")).reason,
    "the image ships no host finalizer",
  );
});

test("standalone entrypoint stays alive after finalization until shutdown", async () => {
  const app = await fixture({ hostWait: true });
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./entrypoint.mjs", import.meta.url))],
    { env: app.environment, stdio: ["ignore", "ignore", "pipe"] },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk.toString();
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    await waitForPath(app.hostRecord, 10_000);
    child.kill("SIGUSR2");
    await waitForPath(join(app.root, "logs", "finalized.json"), 10_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(child.exitCode, null, diagnostics);
    assert.equal(child.signalCode, null, diagnostics);
    assert.equal(
      await readFile(join(app.root, "logs", "runtime.stdout.log"), "utf8"),
      "final host output\n",
    );
    assert.equal(child.kill("SIGTERM"), true);
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally {
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
    }
  }
});

test("finalization kills descendants holding stdout after the host leader exits", async () => {
  const app = await fixture();
  const childReady = join(app.root, "descendant-ready");
  const leaderRecord = join(app.root, "leader-pid");
  const leaderExited = join(app.root, "leader-exited");
  const descendant = [
    'const fs = require("node:fs");',
    'process.on("SIGTERM", () => {});',
    'process.stdout.write("descendant output\\n");',
    `fs.writeFileSync(${JSON.stringify(childReady)}, "ready");`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  await executable(join(app.root, "host.mjs"), [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(leaderRecord)}, String(process.pid));`,
    `process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(leaderExited)}, "exited"); process.exit(0); });`,
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" });`,
    "setInterval(() => {}, 1000);",
  ]);
  const running = runAgentImage(app.environment);
  try {
    await waitForPath(childReady, 10_000);
    process.emit("SIGUSR2");
    await waitForPath(leaderExited, 10_000);
    await waitForPath(join(app.root, "logs", "finalized.json"), 15_000);
    assert.equal(
      await readFile(join(app.root, "logs", "runtime.stdout.log"), "utf8"),
      "descendant output\n",
    );
  } finally {
    await cleanupFixtureGroup(leaderRecord);
    process.emit("SIGTERM");
    await running;
  }
});

test("failed finalization keeps partial evidence available until shutdown", async (context) => {
  const app = await fixture({ hostWait: true });
  const marker = join(app.root, "logs", "finalized.json");
  await mkdir(marker, { recursive: true });
  const failed = new Promise((resolve) => {
    context.mock.method(process.stderr, "write", (chunk) => {
      if (String(chunk).startsWith("runtime finalization failed:")) resolve();
      return true;
    });
  });
  let settled = false;
  const running = runAgentImage(app.environment);
  running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await waitForPath(app.hostRecord, 10_000);
    process.emit("SIGUSR2");
    await Promise.race([failed, running]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(
      await readFile(join(app.root, "logs", "runtime.stdout.log"), "utf8"),
      "final host output\n",
    );
    assert.equal(
      await readFile(join(app.root, "logs", "runtime.stderr.log"), "utf8"),
      "final host error\n",
    );
    assert.equal((await stat(marker)).isDirectory(), true);
  } finally {
    process.emit("SIGTERM");
    await running;
  }
});

/**
 * Bound test failure cleanup to the process group recorded by this fixture.
 * @param {string} leaderRecord Owned group leader PID file.
 * @returns {Promise<void>} Resolves after the kill request or an already-exited group.
 */
async function cleanupFixtureGroup(leaderRecord) {
  const leader = Number(await readFile(leaderRecord, "utf8").catch(() => "0"));
  if (!Number.isSafeInteger(leader) || leader <= 0) return;
  try {
    process.kill(-leader, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
