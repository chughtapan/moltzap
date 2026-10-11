/** @file Built native assets run with an isolated packed Client closure, without a source checkout or another npm product. */

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packageNativePlugins } from "./package-native-plugins.mjs";
import {
  installPackedConsumer,
  packWorkspaceClosure,
  requireCondition,
} from "./test/packed-workspace.mjs";

const exec = promisify(execFile);
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-native-assets-"));
const coreRoots = {
  "@moltzap/client": join(workspaceRoot, "packages/client"),
  "@moltzap/identity": join(workspaceRoot, "packages/identity"),
  "@moltzap/router": join(workspaceRoot, "packages/router"),
};

try {
  const { archives } = await packWorkspaceClosure(
    coreRoots,
    temporaryRoot,
    new Set(Object.keys(coreRoots)),
  );
  const nativeManifest = JSON.parse(
    await readFile(join(workspaceRoot, "plugins/package.json"), "utf8"),
  );
  requireCondition(
    nativeManifest.private === true &&
      nativeManifest.version === undefined &&
      nativeManifest.exports === undefined,
    "native build project must not become an npm product or adapter SDK",
  );
  await verifyRejectedInputs(nativeManifest);
  await verifyDefaultOutput(nativeManifest);
  const dependencies = Object.fromEntries(
    Object.entries(nativeManifest.dependencies).filter(
      ([name]) => name !== "@moltzap/client",
    ),
  );
  const first = await packageNativePlugins(
    workspaceRoot,
    join(temporaryRoot, "first"),
  );
  const second = await packageNativePlugins(
    workspaceRoot,
    join(temporaryRoot, "second"),
  );
  requireCondition(
    first.sha256 === second.sha256,
    "native archive is not reproducible",
  );
  await verifyArchive(first.archive, first.sha256);
  const consumerRoot = await installPackedConsumer({
    temporaryRoot,
    workspaceRoot,
    name: "native-assets-consumer",
    archives: { ...archives, "@moltzap/native-plugins": first.archive },
    dependencies,
  });
  await exec(
    process.execPath,
    ["--input-type=module", "--eval", isolatedHandoff()],
    { cwd: consumerRoot },
  );
  verifyEntrypoint(consumerRoot);
  verifyInstallPrompts(consumerRoot);
  await verifyRemoteHostAssets(consumerRoot);
  process.stdout.write(
    "native assets: rejected unsafe inputs, reproducible archive, isolated install, provider handoff and remote entrypoint passed; native installation and publication remain unqualified\n",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

/**
 * Clearing compiled build outputs must not remove the packaged archive. The
 * default destination is tested on a complete owned source fixture so the
 * release entrypoint and callers share the same output-directory owner.
 * @param {object} nativeManifest Actual private source-project metadata.
 * @returns {Promise<void>}
 */
async function verifyDefaultOutput(nativeManifest) {
  const root = await makeSourceFixture("default-output", nativeManifest);
  for (const path of [
    "bin/receive.mjs",
    "dist/run.js",
    "dist/native/index.js",
    "dist/instinct/index.js",
    "dist/grokbot/index.js",
    "README.md",
    "bin/install-prompt.mjs",
    "dist/muse/index.js",
    "install.md",
    "muse/README.md",
    "muse/install.md",
    "muse/skills/muse/SKILL.md",
    "instinct/install.md",
    "grokbot/install.md",
    "openclaw/install.md",
    "openai-dot/install.md",
    "remote/README.md",
    "remote/receive.service",
    "remote/receive.env.example",
    "remote/callback.conf.example",
  ]) {
    const target = join(root, "plugins", path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(workspaceRoot, "plugins", path), target);
  }
  for (const notice of ["LICENSE", "NOTICE"]) {
    await cp(join(workspaceRoot, notice), join(root, notice));
  }
  const packaged = await packageNativePlugins(root);
  assert.equal(
    dirname(packaged.archive),
    join(root, "dist/artifacts/native-plugins"),
  );
  await rm(join(root, "plugins/dist"), { recursive: true });
  assert.equal(
    createHash("sha256")
      .update(await readFile(packaged.archive))
      .digest("hex"),
    packaged.sha256,
  );
  assert.equal(
    await readFile(`${packaged.archive}.sha256`, "utf8"),
    `${packaged.sha256}  ${basename(packaged.archive)}\n`,
  );
}

/**
 * Unsafe source metadata and symlinked asset paths fail before an artifact is
 * produced. Fixtures live in an owned temporary workspace, never the checkout.
 * @param {object} nativeManifest Actual private source-project metadata.
 * @returns {Promise<void>}
 */
async function verifyRejectedInputs(nativeManifest) {
  const mutations = [
    { private: false },
    { exports: { ".": "./dist/run.js" } },
    { version: "1.0.0" },
    { dependencies: { ...nativeManifest.dependencies, effect: "^3.22.1" } },
    {
      dependencies: {
        ...nativeManifest.dependencies,
        effect: "file:../effect",
      },
    },
  ];
  for (const [index, mutation] of mutations.entries()) {
    const root = await makeSourceFixture(`metadata-${index}`, {
      ...nativeManifest,
      ...mutation,
    });
    await assert.rejects(packageNativePlugins(root, join(root, "output")), {
      code: "ERR_ASSERTION",
    });
    await assert.rejects(lstat(join(root, "output")), {
      code: "ENOENT",
    });
  }
  for (const path of ["bin/receive.mjs", "dist/native"]) {
    const root = await makeSourceFixture(
      path === "bin/receive.mjs" ? "leaf-link" : "ancestor-link",
      nativeManifest,
    );
    await symlink(
      join(workspaceRoot, "plugins", path),
      join(root, "plugins", path),
    );
    await assert.rejects(
      packageNativePlugins(root, join(root, "output")),
      /native archive input (?:must be a regular file|cannot traverse a symlink)/u,
    );
    await assert.rejects(lstat(join(root, "output")), { code: "ENOENT" });
  }
}

/**
 * Copies only manifest/toolchain fixtures; symlink checks need minimal earlier
 * assets so they reach the intended rejection rather than a missing file.
 * @param {string} name Unique fixture directory within the owned test root.
 * @param {object} nativeManifest Source metadata to exercise.
 * @returns {Promise<string>} Isolated source fixture root.
 */
async function makeSourceFixture(name, nativeManifest) {
  const root = join(temporaryRoot, name);
  for (const path of ["plugins/bin", "plugins/dist", "packages/client"]) {
    await mkdir(join(root, path), { recursive: true });
  }
  for (const path of [
    "package.json",
    "packages/client/package.json",
    ".node-version",
  ]) {
    await cp(join(workspaceRoot, path), join(root, path));
  }
  await writeFile(
    join(root, "plugins/package.json"),
    JSON.stringify(nativeManifest),
  );
  if (name === "ancestor-link") {
    await writeFile(join(root, "plugins/bin/receive.mjs"), "// fixture\n");
    await writeFile(join(root, "plugins/dist/run.js"), "// fixture\n");
  }
  return root;
}

/**
 * Reject source, credentials, native account bindings or installation aliases
 * at the actual archive boundary, not only in its declared file list.
 * @param {string} archive Generated private artifact.
 * @param {string} sha256 Reported content digest.
 * @returns {Promise<void>}
 */
async function verifyArchive(archive, sha256) {
  requireCondition(
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex") === sha256,
    "native archive content digest is incorrect",
  );
  const { stdout: listing } = await exec("tar", ["-tzf", archive]);
  const expected = new Set([
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/NOTICE",
    "package/bin/receive.mjs",
    "package/dist/run.js",
    "package/dist/native/index.js",
    "package/dist/instinct/index.js",
    "package/dist/grokbot/index.js",
    "package/bin/install-prompt.mjs",
    "package/dist/muse/index.js",
    "package/install.md",
    "package/muse/README.md",
    "package/muse/install.md",
    "package/muse/skills/muse/SKILL.md",
    "package/instinct/install.md",
    "package/grokbot/install.md",
    "package/openclaw/install.md",
    "package/openai-dot/install.md",
    "package/remote/README.md",
    "package/remote/receive.service",
    "package/remote/receive.env.example",
    "package/remote/callback.conf.example",
  ]);
  const entries = listing.trim().split("\n");
  requireCondition(
    entries.length === expected.size &&
      entries.every((entry) => expected.has(entry)),
    "native archive contains unexpected or missing files",
  );
  const { stdout } = await exec("tar", [
    "-xOf",
    archive,
    "package/package.json",
  ]);
  const manifest = JSON.parse(stdout);
  const client = JSON.parse(
    await readFile(join(workspaceRoot, "packages/client/package.json"), "utf8"),
  );
  requireCondition(
    manifest.private === true &&
      manifest.exports === undefined &&
      manifest.bin === undefined &&
      manifest.version === client.version &&
      manifest.dependencies["@moltzap/client"] === client.version,
    "native archive does not preserve the private same-release Client contract",
  );
  requireCondition(
    !stdout.includes("workspace:") &&
      !stdout.includes("file:") &&
      !stdout.includes("link:"),
    "native archive metadata escaped to a local dependency",
  );
  requireCondition(
    (await readFile(`${archive}.sha256`, "utf8")) ===
      `${sha256}  ${basename(archive)}\n`,
    "native archive digest sidecar disagrees with its content digest",
  );
}

/**
 * The remote command must reach its closed configuration failure through the
 * built Client and Node platform closure, not fail on an unshipped source module.
 * @param {string} consumerRoot Isolated dependency root.
 * @returns {void}
 */
function verifyEntrypoint(consumerRoot) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/@moltzap/native-plugins/bin/receive.mjs"],
    {
      cwd: consumerRoot,
      env: {
        PATH: process.env.PATH,
        MOLTZAP_NATIVE_PLATFORM: "instinct",
        MOLTZAP_MCP_URL: "http://remote.example/mcp",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  requireCondition(
    result.status === 1 &&
      output.includes("invalid-configuration") &&
      !output.includes("ERR_MODULE_NOT_FOUND"),
    "isolated native entrypoint did not fail closed through its real built runtime",
  );
}

/**
 * One initiating prompt uses the same packaged rules for every platform. The
 * renderer reads no owner configuration and changes no account or runtime.
 * @param {string} consumerRoot Isolated dependency root.
 * @returns {void}
 */
function verifyInstallPrompts(consumerRoot) {
  const credential = "fixture-private-credential-must-not-appear";
  const command = "node_modules/@moltzap/native-plugins/bin/install-prompt.mjs";
  const options = {
    cwd: consumerRoot,
    env: { PATH: process.env.PATH, MOLTZAP_MCP_CREDENTIAL: credential },
    encoding: "utf8",
    timeout: 10_000,
  };
  for (const platform of ["muse", "instinct", "grokbot", "openclaw", "dot"]) {
    const result = spawnSync(process.execPath, [command, platform], options);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    requireCondition(
      result.status === 0 &&
        output.includes("# Install or resume MoltZap") &&
        output.includes("Users do not host MoltZap on their computers.") &&
        output.includes("a prompt does not provide account") &&
        !output.includes(credential) &&
        !output.includes("ERR_MODULE_NOT_FOUND"),
      "isolated install prompt lost the common remote or permission contract",
    );
    if (platform === "muse") {
      requireCondition(
        output.includes("native-hook-contract-unverified") &&
          output.includes("do not provision a new runtime"),
        "Muse install prompt must refuse the unverified authenticated hook",
      );
    }
  }
  for (const args of [[], ["nanoclaw"], ["../private"], ["dot", "extra"]]) {
    const result = spawnSync(process.execPath, [command, ...args], options);
    requireCondition(
      result.status === 64 &&
        result.stdout === "" &&
        result.stderr ===
          "usage: install-prompt.mjs muse|instinct|grokbot|openclaw|dot\n",
      "install prompt must refuse unknown, extra or path-like arguments",
    );
  }
}

/**
 * Shared VM assets wrap the shipped receiver with bounded restart and exact
 * callback-only routing; they must not expose daemon administration or tokens.
 * These source assertions do not qualify a live systemd or TLS installation.
 * @param {string} consumerRoot Isolated dependency root.
 * @returns {Promise<void>}
 */
async function verifyRemoteHostAssets(consumerRoot) {
  const root = join(
    consumerRoot,
    "node_modules/@moltzap/native-plugins/remote",
  );
  const [service, environment, callback] = await Promise.all([
    readFile(join(root, "receive.service"), "utf8"),
    readFile(join(root, "receive.env.example"), "utf8"),
    readFile(join(root, "callback.conf.example"), "utf8"),
  ]);
  for (const setting of [
    "User=moltzap",
    "Group=moltzap",
    "Restart=on-failure",
    "RestartSec=10s",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "KillMode=control-group",
    "EnvironmentFile=/etc/moltzap/native-receiver.env",
    "ExecStart=/usr/bin/node /opt/moltzap/native-receiver/node_modules/@moltzap/native-plugins/bin/receive.mjs",
  ]) {
    requireCondition(
      service.split("\n").includes(setting),
      "remote receive unit lost its supervision contract",
    );
  }
  requireCondition(
    environment.includes("MOLTZAP_MCP_URL=http://127.0.0.1:7301/mcp") &&
      environment.includes(
        "MOLTZAP_MCP_CREDENTIAL_FILE=/run/moltzap/runtime/mcp-runtime-credential",
      ) &&
      !environment.includes("MOLTZAPD_MCP_MANAGEMENT_SOCKET=") &&
      !environment.includes("MOLTZAP_MCP_CREDENTIAL="),
    "receiver example must use a protected runtime file, never management or a literal credential",
  );
  requireCondition(
    callback.includes("location = /moltzap/events {") &&
      callback.includes("proxy_pass http://127.0.0.1:4318;") &&
      callback.includes("client_max_body_size 256k;") &&
      callback.includes("access_log off;") &&
      !callback.includes("7301") &&
      !callback.includes("management.sock") &&
      !callback.includes("Authorization"),
    "public VM route must forward only the exact native callback, without a credential bridge",
  );
}

/**
 * The fixture substitutes provider HTTP only; the compiled leaves and dependency closure are real.
 * @returns {string} The isolated consumer program.
 */
function isolatedHandoff() {
  return `
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Redacted } from "effect";
import { makeGrokWakeup } from "@moltzap/native-plugins/dist/grokbot/index.js";
import { makeInstinctWakeup } from "@moltzap/native-plugins/dist/instinct/index.js";
import { preflightMuseInstallation } from "@moltzap/native-plugins/dist/muse/index.js";
const calls = [];
const http = HttpClient.make((request, url) => Effect.sync(() => {
  calls.push(url.href);
  return HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ message_id: "mail-1", thread_id: "thread-1" }), { status: 200 }));
}));
await Effect.runPromise(Effect.gen(function* () {
  const work = { eventId: "evt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
  yield* makeInstinctWakeup({ apiKey: Redacted.make("fixture-agentmail-key"), inboxId: "sender@agentmail.to", recipient: "native@instinct.example" })(work);
  yield* makeGrokWakeup({ key: Redacted.make("fixture-routine-key"), url: new URL("https://native.example/approved?profile=owner") })(work);
}).pipe(Effect.provideService(HttpClient.HttpClient, http)));
if (calls.length !== 2 || calls[1] !== "https://native.example/approved?profile=owner") {
  throw new Error("isolated native provider handoff diverged");
}
if (preflightMuseInstallation().status !== "unsupported") {
  throw new Error("isolated Muse preflight manufactured an authenticated hook");
}
`;
}
