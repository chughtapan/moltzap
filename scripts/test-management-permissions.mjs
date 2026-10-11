#!/usr/bin/env node
/**
 * Runs the packed daemon with a different Linux UID from its runtime caller.
 * Requires root only for dropping fixture subprocesses to UIDs 1001 and 1000;
 * neither user accounts nor deployment configuration are changed. These test
 * identities prove filesystem isolation, not a published image's ownership.
 *
 * --prepare creates a transferable packed consumer without fixture secrets.
 * A Linux root runner accepts that consumer directory as its sole argument;
 * without an argument it prepares and removes its own packed consumer.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = fileURLToPath(import.meta.url);
const workspaceRoot = dirname(dirname(source));
const daemonUid = 1001;
const runtimeUid = 1000;
const maxBuffer = 64 * 1024;

/**
 * @typedef {{port: number, socket: string, key: string, admission: string, daemonGrant: string,
 * hostGrant: string, state: string}} Fixture
 * @typedef {{status: number, body: string}} Response
 */

/**
 * Real Unix and loopback requests exercise the official daemon handler.
 * Literal metadata keys belong to this black-box test, not a transport SDK.
 * @param {Fixture} fixture Private fixture paths and loopback port.
 * @param {string} method MCP method.
 * @param {Record<string, unknown>} params MCP parameters.
 * @param {{socket?: boolean, credential?: string}} [access] Test authority.
 * @returns {Promise<Response>} Bounded HTTP response.
 */
function request(fixture, method, params, access = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/clientInfo": {
          name: "linux-permissions-test",
          version: "1",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      },
    },
  });
  return new Promise((resolveResponse, reject) => {
    const outgoing = httpRequest(
      {
        hostname: "127.0.0.1",
        port: fixture.port,
        path: "/mcp",
        method: "POST",
        ...(access.socket === true ? { socketPath: fixture.socket } : {}),
        headers: {
          host: `127.0.0.1:${fixture.port}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "mcp-method": method,
          ...(typeof params.name === "string"
            ? { "mcp-name": params.name }
            : {}),
          ...(access.credential === undefined
            ? {}
            : { authorization: `Bearer ${access.credential}` }),
        },
        signal: AbortSignal.timeout(5_000),
      },
      (incoming) => {
        const chunks = [];
        let size = 0;
        incoming.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBuffer) {
            outgoing.destroy(new Error("fixture response exceeded its bound"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolveResponse({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

/**
 * UID 1000 can use its one grant but cannot open management or daemon state.
 * @param {Fixture} fixture Private fixture paths and loopback port.
 * @returns {Promise<void>} Assertions on real access attempts.
 */
async function probeRuntime(fixture) {
  assert.equal(process.getuid(), runtimeUid);
  for (const path of [fixture.key, fixture.admission, fixture.daemonGrant]) {
    await assert.rejects(readFile(path), { code: "EACCES" });
  }
  await assert.rejects(readdir(fixture.state), { code: "EACCES" });
  await assert.rejects(
    request(
      fixture,
      "tools/call",
      { name: "status", arguments: {} },
      { socket: true },
    ),
    { code: "EACCES" },
  );
  const credential = await readFile(fixture.hostGrant, "utf8");
  const runtime = await request(fixture, "tools/list", {}, { credential });
  assert.equal(runtime.status, 200);
  assert.deepEqual(JSON.parse(runtime.body).result.tools, []);
  const unauthenticated = await request(fixture, "tools/list", {});
  assert.equal(unauthenticated.status, 401);
  const denied = await request(
    fixture,
    "tools/call",
    { name: "status", arguments: {} },
    { credential },
  );
  assert.equal(JSON.parse(denied.body).error.code, -32602);
  assert.equal(JSON.parse(denied.body).result, undefined);
}

/**
 * UID 1001 retains management without any owner bearer credential.
 * @param {Fixture} fixture Private fixture paths and loopback port.
 * @returns {Promise<void>} Assertions on the private MCP route.
 */
async function probeOwner(fixture) {
  assert.equal(process.getuid(), daemonUid);
  const response = await request(
    fixture,
    "tools/call",
    { name: "status", arguments: {} },
    { socket: true },
  );
  assert.equal(response.status, 200);
  assert.equal(
    JSON.parse(response.body).result.structuredContent.kind,
    "unregistered",
  );
}

/**
 * Atomically reserves a port while choosing it; later bind contention fails
 * the startup check rather than changing another process's listener.
 * @returns {Promise<number>} Available loopback port.
 */
async function choosePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise((resolveClose, reject) =>
    server.close((error) =>
      error === undefined ? resolveClose() : reject(error),
    ),
  );
  return port;
}

/**
 * Cleanup signals only the child retained by this fixture, never a discovered PID.
 * @param {import("node:child_process").ChildProcess} child Owned daemon process.
 * @returns {Promise<void>} Process termination.
 */
async function stopDaemon(child) {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
    throw new Error("fixture daemon did not stop gracefully");
  }
}

/**
 * The producer and packed-install helper remain the sole release fixture owners.
 * No signing keys or bearer values exist in this transferable bundle.
 * Its code root is traversable by fixture UIDs; private inputs are generated
 * only inside the runner's separately owned private directories.
 * @returns {Promise<{root: string, consumer: string, archive: string}>} Owned fixture.
 */
async function prepareConsumer() {
  const { packWorkspaceClosure, installPackedConsumer } = await import(
    "./test/packed-workspace.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "moltzap-permissions-pack-"));
  try {
    const packageRoots = Object.fromEntries(
      ["client", "identity", "router"].map((name) => [
        `@moltzap/${name}`,
        join(workspaceRoot, "packages", name),
      ]),
    );
    const { archives } = await packWorkspaceClosure(
      packageRoots,
      root,
      new Set(Object.keys(packageRoots)),
    );
    const consumer = await installPackedConsumer({
      temporaryRoot: root,
      workspaceRoot,
      name: "moltzap-linux-permissions-consumer",
      archives,
    });
    await mkdir(join(root, "scripts"));
    await copyFile(
      source,
      join(root, "scripts/test-management-permissions.mjs"),
    );
    await copyFile(
      join(workspaceRoot, ".node-version"),
      join(root, ".node-version"),
    );
    const archive = join(root, "fixture.tgz");
    await exec(
      "tar",
      [
        ...(process.platform === "darwin" ? ["--no-xattrs"] : []),
        "-czf",
        archive,
        "-C",
        root,
        "consumer",
        "tarballs",
        "scripts",
        ".node-version",
      ],
      { maxBuffer, env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    await chmod(root, 0o755);
    return { root, consumer, archive };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Uses only generated secrets and owned directories. Restart checks that the
 * socket is released and the same runtime grant still authorizes the daemon.
 * An unregistered fixture deliberately makes no Registry or Router claims.
 * @param {string} consumer Isolated, installed packed Client closure.
 * @returns {Promise<void>} Actual Linux permission and restart checks.
 */
async function verifyPermissions(consumer) {
  const pinnedNode = (
    await readFile(join(workspaceRoot, ".node-version"), "utf8")
  ).trim();
  assert.equal(process.versions.node, pinnedNode);
  const manifest = JSON.parse(
    await readFile(
      join(consumer, "node_modules/@moltzap/client/package.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.name, "@moltzap/client");
  const root = await mkdtemp("/tmp/mz-permissions-");
  try {
    await chmod(root, 0o755);
    const node = join(root, "node");
    const probe = join(root, "probe.mjs");
    await copyFile(process.execPath, node);
    await chmod(node, 0o755);
    await copyFile(source, probe);
    await chmod(probe, 0o644);
    const privateRoot = join(root, "daemon");
    const runtimeRoot = join(root, "runtime");
    for (const [directory, uid] of [
      [privateRoot, daemonUid],
      [runtimeRoot, runtimeUid],
    ]) {
      await mkdir(directory, { mode: 0o700 });
      await chown(directory, uid, uid);
    }
    const state = join(privateRoot, "state");
    await mkdir(state, { mode: 0o700 });
    await chown(state, daemonUid, daemonUid);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" });
    const grant = randomBytes(32).toString("base64url");
    const fixture = {
      port: await choosePort(),
      socket: join(privateRoot, "mcp.sock"),
      key: join(privateRoot, "signing-key"),
      admission: join(privateRoot, "admission"),
      daemonGrant: join(privateRoot, "runtime-grant"),
      hostGrant: join(runtimeRoot, "runtime-grant"),
      state,
    };
    for (const [path, value, uid] of [
      [
        fixture.key,
        privateKey.export({ type: "pkcs8", format: "pem" }),
        daemonUid,
      ],
      [fixture.daemonGrant, grant, daemonUid],
      [fixture.admission, randomBytes(32).toString("base64url"), daemonUid],
      [fixture.hostGrant, grant, runtimeUid],
    ]) {
      await writeFile(path, value, { mode: 0o400 });
      await chown(path, uid, uid);
    }
    const environment = {
      PATH: dirname(node),
      MOLTZAPD_STATE_DIRECTORY: state,
      MOLTZAPD_MCP_PORT: String(fixture.port),
      MOLTZAPD_REGISTRY_ORIGIN: "http://127.0.0.1:1",
      MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY: JSON.stringify({
        crv: "Ed25519",
        kty: "OKP",
        x: jwk.x,
      }),
      MOLTZAPD_ROUTER_ORIGIN: "http://127.0.0.1:1",
      MOLTZAPD_AGENT_PRIVATE_KEY_FILE: fixture.key,
      MOLTZAPD_ADMISSION_CREDENTIAL_FILE: fixture.admission,
      MOLTZAPD_MCP_RUNTIME_CREDENTIAL_FILE: fixture.daemonGrant,
      MOLTZAPD_MCP_MANAGEMENT_SOCKET: fixture.socket,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawn(
        node,
        [join(consumer, "node_modules/@moltzap/client/bin/moltzapd")],
        {
          cwd: consumer,
          uid: daemonUid,
          gid: daemonUid,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let diagnostic = "";
      for (const output of [child.stdout, child.stderr]) {
        output.setEncoding("utf8");
        output.on("data", (chunk) => {
          diagnostic = (diagnostic + chunk).slice(0, maxBuffer);
        });
      }
      let startupError;
      child.on("error", (error) => {
        startupError = error;
      });
      try {
        const deadline = Date.now() + 30_000;
        while (
          !(await stat(fixture.socket).catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          }))
        ) {
          assert.equal(
            startupError,
            undefined,
            "fixture daemon failed to start",
          );
          assert.equal(
            child.exitCode,
            null,
            `fixture daemon exited before binding: ${diagnostic}`,
          );
          assert.equal(
            child.signalCode,
            null,
            "fixture daemon was signaled before binding",
          );
          assert.ok(
            Date.now() < deadline,
            "fixture daemon startup deadline exceeded",
          );
          await delay(50);
        }
        const socket = await stat(fixture.socket);
        assert.ok(socket.isSocket());
        assert.equal(socket.uid, daemonUid);
        assert.equal(socket.mode & 0o7777, 0o600);
        for (const [role, uid] of [
          ["owner", daemonUid],
          ["runtime", runtimeUid],
        ]) {
          await exec(node, [probe, "--probe", role, JSON.stringify(fixture)], {
            cwd: consumer,
            uid,
            gid: uid,
            env: { PATH: dirname(node) },
            timeout: 15_000,
            maxBuffer,
          });
        }
      } finally {
        await stopDaemon(child);
      }
      await assert.rejects(stat(fixture.socket), { code: "ENOENT" });
    }
    console.log(
      `Linux packed daemon ${manifest.version}: UID isolation, management/runtime authority, socket cleanup and same-grant restart passed; image/native installation remains unqualified`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--prepare") {
  assert.equal(process.argv.length, 3);
  console.log(JSON.stringify(await prepareConsumer()));
} else if (process.argv[2] === "--probe") {
  assert.equal(process.argv.length, 5);
  const fixture = JSON.parse(process.argv[4]);
  if (process.argv[3] === "owner") await probeOwner(fixture);
  else if (process.argv[3] === "runtime") await probeRuntime(fixture);
  else throw new Error("unknown fixture probe role");
} else {
  assert.equal(
    process.platform,
    "linux",
    "management UID isolation requires Linux",
  );
  assert.equal(
    process.getuid(),
    0,
    "management UID isolation requires a root fixture runner",
  );
  assert.ok(
    process.argv.length <= 3,
    "expected only an isolated consumer directory",
  );
  const prepared =
    process.argv[2] === undefined ? await prepareConsumer() : undefined;
  try {
    await verifyPermissions(prepared?.consumer ?? resolve(process.argv[2]));
  } finally {
    if (prepared !== undefined)
      await rm(prepared.root, { recursive: true, force: true });
  }
}
