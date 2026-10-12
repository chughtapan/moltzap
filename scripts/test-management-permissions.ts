#!/usr/bin/env node
/**
 * @file Runs the packed daemon with a distinct Linux UID from its runtime caller.
 * Root only drops fixture subprocesses to UIDs 1001 and 1000; it changes no user
 * accounts or deployment configuration. These synthetic identities qualify
 * filesystem isolation, not ownership in a published image or installation.
 * --prepare creates a transferable packed consumer without fixture secrets.
 * The transferred-consumer root runner and copied probes execute only Node built-ins.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
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
// eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- Standalone fixture bootstrap snapshots the tar environment; copied UID probes cannot load a Config dependency.
const environment = process.env;

interface Fixture {
  readonly port: number;
  readonly socket: string;
  readonly key: string;
  readonly admission: string;
  readonly daemonGrant: string;
  readonly hostGrant: string;
  readonly state: string;
}
interface ProbeResponse {
  readonly status: number;
  readonly body: string;
}
interface Access {
  readonly socket?: boolean;
  readonly credential?: string;
}
interface FixtureRun {
  readonly consumer: string;
  readonly node: string;
  readonly probe: string;
  readonly fixture: Fixture;
  readonly env: Readonly<Record<string, string>>;
}
interface RunningDaemon {
  readonly child: ChildProcess;
  readonly diagnostic: () => string;
  readonly startupError: () => Error | undefined;
}

/** Only normal-user preparation executes the workspace's dependency-based pack helper. */
async function main() {
  if (process.argv[2] === "--prepare") {
    assert.equal(process.argv.length, 3);
    assert.notEqual(
      process.getuid?.(),
      0,
      "prepare the packed consumer as a normal user, not root",
    );
    console.log(JSON.stringify(await prepareConsumer()));
    return;
  }
  if (process.argv[2] === "--probe") {
    await runProbe();
    return;
  }
  assert.equal(
    process.platform,
    "linux",
    "management UID isolation requires Linux",
  );
  assert.equal(
    process.getuid?.(),
    0,
    "management UID isolation requires a root fixture runner",
  );
  assert.equal(
    process.argv.length,
    3,
    "expected a prepared consumer directory; run --prepare as a normal user first",
  );
  const consumer = process.argv[2];
  assert.ok(consumer !== undefined);
  await verifyPermissions(resolve(consumer));
}

/** The transferable bundle has code and pinned toolchain metadata, never authority. */
async function prepareConsumer() {
  const root = await mkdtemp(join(tmpdir(), "moltzap-permissions-pack-"));
  try {
    const consumer = await installConsumer(root);
    await mkdir(join(root, "scripts"));
    await copyFile(
      source,
      join(root, "scripts/test-management-permissions.ts"),
    );
    await copyFile(
      join(workspaceRoot, ".node-version"),
      join(root, ".node-version"),
    );
    const archive = await createBundle(root);
    await chmod(root, 0o755);
    return { root, consumer, archive };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function installConsumer(root: string) {
  const { packWorkspaceClosure, installPackedConsumer } = await import(
    "./test/packed-workspace.ts"
  );
  const { NodeContext } = await import("@effect/platform-node");
  const { Effect } = await import("effect");
  const packageRoots = Object.fromEntries(
    ["client", "identity", "router"].map((name) => [
      `@moltzap/${name}`,
      join(workspaceRoot, "packages", name),
    ]),
  );
  const { archives } = await Effect.runPromise(
    packWorkspaceClosure(
      packageRoots,
      root,
      new Set(Object.keys(packageRoots)),
    ).pipe(Effect.provide(NodeContext.layer)),
  );
  return await Effect.runPromise(
    installPackedConsumer({
      temporaryRoot: root,
      workspaceRoot,
      name: "moltzap-linux-permissions-consumer",
      archives,
    }).pipe(Effect.provide(NodeContext.layer)),
  );
}

async function createBundle(root: string) {
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
    { maxBuffer, env: { ...environment, COPYFILE_DISABLE: "1" } },
  );
  return archive;
}

/** An unregistered daemon makes no live Registry, Router, or image claims. */
async function verifyPermissions(consumer: string) {
  const pinnedNode = (
    await readFile(join(workspaceRoot, ".node-version"), "utf8")
  ).trim();
  assert.equal(process.versions.node, pinnedNode);
  const manifest = decodeObject(
    await readFile(
      join(consumer, "node_modules/@moltzap/client/package.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.name, "@moltzap/client");
  // mkdtemp atomically owns this exact unpredictable child; cleanup never targets /tmp itself.
  const root = await mkdtemp(join(tmpdir(), "mz-permissions-"));
  try {
    const run = await makeFixture(root, consumer);
    for (let attempt = 0; attempt < 2; attempt++) {
      await verifyRestart(run);
    }
    console.log(
      `Linux packed daemon ${String(manifest.version)}: UID isolation, management/runtime authority, socket cleanup and same-grant restart passed; image/native installation remains unqualified`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeFixture(
  root: string,
  consumer: string,
): Promise<FixtureRun> {
  await chmod(root, 0o755);
  const node = join(root, "node");
  const probe = join(root, "probe.ts");
  await copyFile(process.execPath, node);
  await chmod(node, 0o755);
  await copyFile(source, probe);
  await chmod(probe, 0o644);
  const privateRoot = join(root, "daemon");
  const runtimeRoot = join(root, "runtime");
  const state = join(privateRoot, "state");
  const directories: ReadonlyArray<readonly [string, number]> = [
    [privateRoot, daemonUid],
    [runtimeRoot, runtimeUid],
    [state, daemonUid],
  ];
  for (const [directory, uid] of directories) {
    await mkdir(directory, { mode: 0o700 });
    await chown(directory, uid, uid);
  }
  const fixture: Fixture = {
    port: await choosePort(),
    socket: join(privateRoot, "mcp.sock"),
    key: join(privateRoot, "signing-key"),
    admission: join(privateRoot, "admission"),
    daemonGrant: join(privateRoot, "runtime-grant"),
    hostGrant: join(runtimeRoot, "runtime-grant"),
    state,
  };
  const publicKey = await writeFixtureAuthority(fixture);
  return {
    consumer,
    node,
    probe,
    fixture,
    env: daemonEnvironment(node, fixture, publicKey),
  };
}

async function writeFixtureAuthority(fixture: Fixture): Promise<string> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const grant = randomBytes(32).toString("base64url");
  const files: ReadonlyArray<readonly [string, string | Buffer, number]> = [
    [
      fixture.key,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      daemonUid,
    ],
    [fixture.daemonGrant, grant, daemonUid],
    [fixture.admission, randomBytes(32).toString("base64url"), daemonUid],
    [fixture.hostGrant, grant, runtimeUid],
  ];
  for (const [path, value, uid] of files) {
    await writeFile(path, value, { mode: 0o400 });
    await chown(path, uid, uid);
  }
  const jwk = publicKey.export({ format: "jwk" });
  return JSON.stringify({ crv: "Ed25519", kty: "OKP", x: jwk.x });
}

function daemonEnvironment(
  node: string,
  fixture: Fixture,
  publicKey: string,
): Readonly<Record<string, string>> {
  return {
    PATH: dirname(node),
    MOLTZAPD_STATE_DIRECTORY: fixture.state,
    MOLTZAPD_MCP_PORT: String(fixture.port),
    MOLTZAPD_REGISTRY_ORIGIN: "http://127.0.0.1:1",
    MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY: publicKey,
    MOLTZAPD_ROUTER_ORIGIN: "http://127.0.0.1:1",
    MOLTZAPD_AGENT_PRIVATE_KEY_FILE: fixture.key,
    MOLTZAPD_ADMISSION_CREDENTIAL_FILE: fixture.admission,
    MOLTZAPD_MCP_RUNTIME_CREDENTIAL_FILE: fixture.daemonGrant,
    MOLTZAPD_MCP_MANAGEMENT_SOCKET: fixture.socket,
  };
}

/** The same files and grant survive a clean stop/restart; only the owned child is signaled. */
async function verifyRestart(run: FixtureRun) {
  const daemon = startDaemon(run);
  try {
    await waitForSocket(daemon, run.fixture.socket);
    const socket = await stat(run.fixture.socket);
    assert.ok(socket.isSocket());
    assert.equal(socket.uid, daemonUid);
    assert.equal(socket.mode & 0o7777, 0o600);
    await verifyProbes(run);
  } finally {
    await stopDaemon(daemon.child);
  }
  await assert.rejects(stat(run.fixture.socket), { code: "ENOENT" });
}

function startDaemon(run: FixtureRun): RunningDaemon {
  const child = spawn(
    run.node,
    [join(run.consumer, "node_modules/@moltzap/client/bin/moltzapd")],
    {
      cwd: run.consumer,
      uid: daemonUid,
      gid: daemonUid,
      env: run.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const status: { diagnostic: string; startupError?: Error } = {
    diagnostic: "",
  };
  for (const output of [child.stdout, child.stderr]) {
    assert.ok(output !== null);
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      status.diagnostic = (status.diagnostic + chunk).slice(0, maxBuffer);
    });
  }
  child.on("error", (error) => {
    status.startupError = error;
  });
  return {
    child,
    diagnostic: () => status.diagnostic,
    startupError: () => status.startupError,
  };
}

async function waitForSocket(daemon: RunningDaemon, socket: string) {
  const deadline = Date.now() + 30_000;
  while (!(await socketExists(socket))) {
    assert.equal(
      daemon.startupError(),
      undefined,
      "fixture daemon failed to start",
    );
    assert.equal(
      daemon.child.exitCode,
      null,
      `fixture daemon exited before binding: ${daemon.diagnostic()}`,
    );
    assert.equal(
      daemon.child.signalCode,
      null,
      "fixture daemon was signaled before binding",
    );
    assert.ok(
      Date.now() < deadline,
      "fixture daemon startup deadline exceeded",
    );
    await delay(50);
  }
}

async function socketExists(socket: string): Promise<boolean> {
  try {
    await stat(socket);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function verifyProbes(run: FixtureRun) {
  const probes: ReadonlyArray<readonly [string, number]> = [
    ["owner", daemonUid],
    ["runtime", runtimeUid],
  ];
  for (const [role, uid] of probes) {
    await exec(
      run.node,
      [run.probe, "--probe", role, JSON.stringify(run.fixture)],
      {
        cwd: run.consumer,
        uid,
        gid: uid,
        env: { PATH: dirname(run.node) },
        timeout: 15_000,
        maxBuffer,
      },
    );
  }
}

async function stopDaemon(child: ChildProcess) {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
    assert.fail("fixture daemon did not stop gracefully");
  }
}

async function runProbe() {
  assert.equal(process.argv.length, 5);
  const fixture = decodeFixture(process.argv[4]);
  if (process.argv[3] === "owner") {
    await probeOwner(fixture);
  } else if (process.argv[3] === "runtime") {
    await probeRuntime(fixture);
  } else {
    assert.fail("unknown fixture probe role");
  }
}

/** UID 1001 keeps management without any owner bearer credential. */
async function probeOwner(fixture: Fixture) {
  assert.equal(process.getuid?.(), daemonUid);
  const response = await request(
    fixture,
    "tools/call",
    { name: "status", arguments: {} },
    { socket: true },
  );
  assert.equal(response.status, 200);
  assert.equal(
    objectAt(
      objectAt(decodeObject(response.body), "result"),
      "structuredContent",
    ).kind,
    "unregistered",
  );
}

/** UID 1000 uses its grant but cannot open management or daemon state. */
async function probeRuntime(fixture: Fixture) {
  assert.equal(process.getuid?.(), runtimeUid);
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
  assert.deepEqual(objectAt(decodeObject(runtime.body), "result").tools, []);
  const unauthenticated = await request(fixture, "tools/list", {});
  assert.equal(unauthenticated.status, 401);
  const denied = await request(
    fixture,
    "tools/call",
    { name: "status", arguments: {} },
    { credential },
  );
  assert.equal(objectAt(decodeObject(denied.body), "error").code, -32602);
  assert.equal(decodeObject(denied.body).result, undefined);
}

/** Port contention fails startup rather than altering another process's listener. */
async function choosePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise<undefined>((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose(undefined);
      } else {
        reject(error);
      }
    });
  });
  return port;
}

/** Real Unix/loopback requests exercise the official daemon's black-box MCP handler. */
function request(
  fixture: Fixture,
  method: string,
  params: Readonly<Record<string, unknown>>,
  access: Access = {},
): Promise<ProbeResponse> {
  const body = requestBody(method, params);
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
        readResponse(incoming, resolveResponse, reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function requestBody(
  method: string,
  params: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify({
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
}

function readResponse(
  incoming: IncomingMessage,
  resolveResponse: (response: ProbeResponse) => void,
  reject: (error: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  incoming.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBuffer) {
      incoming.destroy(new Error("fixture response exceeded its bound"));
      return;
    }
    chunks.push(chunk);
  });
  incoming.on("error", reject);
  incoming.on("end", () => {
    resolveResponse({
      status: incoming.statusCode ?? 0,
      body: Buffer.concat(chunks).toString("utf8"),
    });
  });
}

/** Probe arguments cross the untyped JSON process boundary. */
function decodeFixture(text?: string): Fixture {
  assert.ok(text !== undefined);
  const fixture = decodeObject(text);
  assert.ok(
    typeof fixture.port === "number" &&
      Number.isSafeInteger(fixture.port) &&
      fixture.port > 0 &&
      fixture.port <= 65535,
  );
  const strings = [
    "socket",
    "key",
    "admission",
    "daemonGrant",
    "hostGrant",
    "state",
  ] as const;
  for (const name of strings) {
    assert.ok(typeof fixture[name] === "string");
  }
  return {
    port: fixture.port,
    socket: String(fixture.socket),
    key: String(fixture.key),
    admission: String(fixture.admission),
    daemonGrant: String(fixture.daemonGrant),
    hostGrant: String(fixture.hostGrant),
    state: String(fixture.state),
  };
}

function decodeObject(text: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text);
  assert.ok(isObject(value));
  return value;
}

function objectAt(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const nested = value[key];
  assert.ok(isObject(nested));
  return nested;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

await main();
