import assert from "node:assert/strict";
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
      : "await new Promise((resolve) => setTimeout(resolve, 150));",
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
    "await writeFile(process.env.TEST_HOST_RECORD, JSON.stringify(process.env));",
    options.hostWait === true
      ? 'const keepAlive = setInterval(() => {}, 1000); await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); }); clearInterval(keepAlive);'
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

test("successful bootstrap starts the host with separated credentials", async () => {
  const app = await fixture();

  assert.equal(await runAgentImage(app.environment), 0);

  const daemonEnvironment = JSON.parse(
    await readFile(join(app.state, "daemon-env.json"), "utf8"),
  );
  const hostEnvironment = JSON.parse(await readFile(app.hostRecord, "utf8"));
  assert.equal(daemonEnvironment.ANTHROPIC_API_KEY, undefined);
  assert.equal(hostEnvironment.ANTHROPIC_API_KEY, "model-secret");
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
