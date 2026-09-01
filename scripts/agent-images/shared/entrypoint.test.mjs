import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(source, { recursive: true }),
  );
  await writeFile(join(source, "agent-private-key"), "private");
  await writeFile(join(source, "admission-credential"), "admission");

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
    "process.exitCode = " + String(options.hostExitCode ?? 0) + ";",
  ]);
  const hostCommand = join(root, "host-command.json");
  await writeFile(hostCommand, JSON.stringify([process.execPath, host]));

  return {
    hostRecord,
    hostStarts,
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
