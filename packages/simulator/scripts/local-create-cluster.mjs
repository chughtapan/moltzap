// Creates the pinned local Kubernetes profile without replacing an existing
// cluster. A failed installation is left intact for inspection.
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const localRoot = join(packageRoot, "local");
const profilePath = join(localRoot, "profile.json");
const kindTemplatePath = join(localRoot, "kind-config.yaml");
const queuePath = join(localRoot, "queue.yaml");
const temporalPath = join(localRoot, "temporal.yaml");
const toolsRoot = join(localRoot, ".tools");
const DEFAULT_ARTIFACTS = join(localRoot, "artifacts");
const ARTIFACT_TOKEN = "__MOLTZAP_ARTIFACTS__";
const SHA256 = /^[0-9a-f]{64}$/;
const PINNED_IMAGE = /^.+@sha256:[0-9a-f]{64}$/;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const IMAGE_DISCOVERY_ATTEMPTS = 30;
const IMAGE_DISCOVERY_INTERVAL_MS = 500;

function report(message) {
  process.stderr.write(`[moltzap local] ${message}\n`);
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function digest(value, label) {
  const encoded = text(value, label);
  if (!SHA256.test(encoded)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return encoded;
}

function platformAsset(section, label) {
  const key = `${process.platform}-${process.arch}`;
  const binaries = record(section.binaries, `${label}.binaries`);
  const asset = record(binaries[key], `${label}.binaries.${key}`);
  return {
    url: text(asset.url, `${label} binary URL`),
    sha256: digest(asset.sha256, `${label} binary checksum`),
  };
}

function validateProfile(value) {
  const profile = record(value, "local profile");
  if (profile.apiVersion !== "moltzap.local-profile/v1") {
    throw new TypeError("unsupported local profile apiVersion");
  }
  const kind = record(profile.kind, "local profile kind");
  const kubectl = record(profile.kubectl, "local profile kubectl");
  const kueue = record(profile.kueue, "local profile Kueue");
  const agentSandbox = record(
    profile.agentSandbox,
    "local profile Agent Sandbox",
  );
  return {
    clusterName: text(profile.clusterName, "local profile clusterName"),
    kind: {
      version: text(kind.version, "local profile kind.version"),
      nodeImage: text(kind.nodeImage, "local profile kind.nodeImage"),
      asset: platformAsset(kind, "kind"),
    },
    kubectl: {
      version: text(kubectl.version, "local profile kubectl.version"),
      asset: platformAsset(kubectl, "kubectl"),
    },
    kueue: {
      url: text(kueue.manifestUrl, "local profile Kueue manifest URL"),
      sha256: digest(
        kueue.manifestSha256,
        "local profile Kueue manifest checksum",
      ),
    },
    agentSandbox: {
      url: text(
        agentSandbox.manifestUrl,
        "local profile Agent Sandbox manifest URL",
      ),
      sha256: digest(
        agentSandbox.manifestSha256,
        "local profile Agent Sandbox manifest checksum",
      ),
    },
    clusterQueue: text(profile.clusterQueue, "local profile clusterQueue"),
    localQueue: text(profile.localQueue, "local profile localQueue"),
    temporalImage: text(profile.temporalImage, "local profile temporalImage"),
    artifactNodePath: text(
      profile.artifactNodePath,
      "local profile artifactNodePath",
    ),
  };
}

async function readProfile() {
  const value = JSON.parse(await readFile(profilePath, "utf8"));
  return validateProfile(value);
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function download(url, expectedDigest, destination) {
  try {
    const present = await readFile(destination);
    if (hash(present) === expectedDigest) {
      return destination;
    }
  } catch (cause) {
    if (cause?.code !== "ENOENT") {
      throw cause;
    }
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`download failed with HTTP ${String(response.status)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== expectedDigest) {
    throw new Error("download did not match its pinned SHA-256 digest");
  }
  const temporary = `${destination}.${String(process.pid)}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, destination);
  return destination;
}

async function tool(name, version, asset) {
  const directory = join(toolsRoot, `${process.platform}-${process.arch}`);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `${name}-${version}`);
  await download(asset.url, asset.sha256, destination);
  await chmod(destination, 0o755);
  return destination;
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(
          new Error(
            `${command} stopped with ${signal ?? `exit ${String(code)}`}`,
          ),
        );
      }
    });
  });
}

function parseArguments(args, defaults) {
  const options = {
    artifacts: DEFAULT_ARTIFACTS,
    cluster: defaults.clusterName,
    image: undefined,
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new TypeError(`${flag ?? "argument"} needs a value`);
    }
    if (flag === "--artifacts") {
      options.artifacts = resolve(value);
    } else if (flag === "--cluster") {
      options.cluster = value;
    } else if (flag === "--image") {
      options.image = value;
    } else {
      throw new TypeError(`unknown local cluster option ${flag}`);
    }
  }
  if (options.cluster.length > 63 || !DNS_LABEL.test(options.cluster)) {
    throw new TypeError("local cluster name must be one Kubernetes DNS label");
  }
  if (options.image !== undefined && !PINNED_IMAGE.test(options.image)) {
    throw new TypeError("--image must be a SHA-256 digest-pinned image");
  }
  return options;
}

export function normalizeContainerdReference(reference) {
  const slash = reference.indexOf("/");
  let domain;
  let remoteName;
  if (slash === -1) {
    domain = "docker.io";
    remoteName = reference;
  } else {
    const possibleDomain = reference.slice(0, slash);
    const possibleRemoteName = reference.slice(slash + 1);
    if (possibleDomain === "index.docker.io") {
      domain = "docker.io";
      remoteName = possibleRemoteName;
    } else if (
      possibleDomain === "localhost" ||
      possibleDomain.includes(".") ||
      possibleDomain.includes(":") ||
      possibleDomain.toLowerCase() !== possibleDomain
    ) {
      domain = possibleDomain;
      remoteName = possibleRemoteName;
    } else {
      domain = "docker.io";
      remoteName = reference;
    }
  }
  if (domain === "docker.io" && !remoteName.includes("/")) {
    remoteName = `library/${remoteName}`;
  }
  return `${domain}/${remoteName}`;
}

function repositoryReference(reference) {
  const digest = reference.indexOf("@");
  const named = digest === -1 ? reference : reference.slice(0, digest);
  const tag = named.lastIndexOf(":");
  return tag > named.lastIndexOf("/") ? named.slice(0, tag) : named;
}

export function selectLocalImageTag(tags, pinnedImage) {
  const candidates = tags.filter(
    (tag) => typeof tag === "string" && tag.length > 0 && !tag.includes("@"),
  );
  if (candidates.length === 0) {
    throw new Error("controller image has no local repository tag");
  }
  const repository = normalizeContainerdReference(
    repositoryReference(pinnedImage),
  );
  return (
    candidates.find(
      (tag) =>
        normalizeContainerdReference(repositoryReference(tag)) === repository,
    ) ?? candidates[0]
  );
}

async function localImageTag(image) {
  const { stdout } = await exec(
    "docker",
    ["image", "inspect", "--format", "{{json .RepoTags}}", image],
    { timeout: 30_000 },
  );
  let tags;
  try {
    tags = JSON.parse(stdout);
  } catch (cause) {
    throw new Error("Docker returned invalid controller image tags", { cause });
  }
  if (!Array.isArray(tags)) {
    throw new Error("Docker returned invalid controller image tags");
  }
  return selectLocalImageTag(tags, image);
}

export async function retryImageDiscovery(
  discover,
  {
    attempts = IMAGE_DISCOVERY_ATTEMPTS,
    intervalMs = IMAGE_DISCOVERY_INTERVAL_MS,
    pause = delay,
  } = {},
) {
  let lastFailure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await discover();
      return;
    } catch (cause) {
      lastFailure = cause;
      if (attempt + 1 < attempts) {
        await pause(intervalMs);
      }
    }
  }
  throw new Error(
    `image did not become discoverable after ${String(attempts)} attempts`,
    { cause: lastFailure },
  );
}

async function makePinnedImageDiscoverable(kind, cluster, source, image) {
  const sourceReference = normalizeContainerdReference(source);
  const digestReference = normalizeContainerdReference(image);
  const { stdout: nodeOutput } = await exec(
    kind,
    ["get", "nodes", "--name", cluster],
    { timeout: 30_000 },
  );
  const nodes = nodeOutput.split(/\s+/u).filter(Boolean);
  if (nodes.length === 0) {
    throw new Error("kind returned no nodes for the new cluster");
  }
  for (const node of nodes) {
    try {
      await retryImageDiscovery(async () => {
        await exec(
          "docker",
          [
            "exec",
            node,
            "ctr",
            "-n",
            "k8s.io",
            "images",
            "tag",
            "--force",
            "--skip-reference-check",
            sourceReference,
            digestReference,
          ],
          { timeout: 5_000 },
        );
        await exec(
          "docker",
          ["exec", node, "crictl", "inspecti", digestReference],
          { timeout: 5_000 },
        );
      });
    } catch (cause) {
      throw new Error(
        `controller image did not become discoverable on kind node ${node}`,
        { cause },
      );
    }
  }
}

async function renderKindConfiguration(artifacts, destination, profile) {
  const template = await readFile(kindTemplatePath, "utf8");
  if (
    !template.includes(ARTIFACT_TOKEN) ||
    !template.includes(profile.kind.nodeImage)
  ) {
    throw new Error("kind configuration does not match the pinned profile");
  }
  await writeFile(
    destination,
    template.replaceAll(ARTIFACT_TOKEN, JSON.stringify(artifacts)),
  );
}

async function assertNewCluster(kind, name) {
  const { stdout } = await exec(kind, ["get", "clusters"], {
    timeout: 30_000,
  });
  const clusters = stdout.split(/\s+/u).filter(Boolean);
  if (clusters.includes(name)) {
    throw new Error(
      `kind cluster ${name} already exists; this setup never replaces it`,
    );
  }
}

async function kubectlApply(kubectl, context, path) {
  await run(kubectl, [
    "--context",
    context,
    "apply",
    "--server-side",
    "-f",
    path,
  ]);
}

async function rollout(kubectl, context, namespace, deployment) {
  await run(kubectl, [
    "--context",
    context,
    "--namespace",
    namespace,
    "rollout",
    "status",
    `deployment/${deployment}`,
    "--timeout=5m",
  ]);
}

async function waitForKueueWebhook(kubectl, context) {
  let lastFailure;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await exec(
        kubectl,
        [
          "--context",
          context,
          "create",
          "deployment",
          "moltzap-kueue-webhook-probe",
          "--image=example.invalid/moltzap-probe:never",
          "--dry-run=server",
          "--output=name",
        ],
        { timeout: 10_000 },
      );
      return;
    } catch (cause) {
      lastFailure = cause;
      await delay(1_000);
    }
  }
  throw new Error("Kueue admission webhook did not become ready within 60s", {
    cause: lastFailure,
  });
}

async function installProfile(kubectl, context, profile, temporary) {
  const kueueManifest = join(temporary, "kueue.yaml");
  const sandboxManifest = join(temporary, "agent-sandbox.yaml");
  report("downloading checksum-pinned controller manifests");
  await Promise.all([
    download(profile.kueue.url, profile.kueue.sha256, kueueManifest),
    download(
      profile.agentSandbox.url,
      profile.agentSandbox.sha256,
      sandboxManifest,
    ),
  ]);

  report("installing Kueue");
  await kubectlApply(kubectl, context, kueueManifest);
  await rollout(kubectl, context, "kueue-system", "kueue-controller-manager");
  await waitForKueueWebhook(kubectl, context);

  report("installing Agent Sandbox");
  await kubectlApply(kubectl, context, sandboxManifest);
  await rollout(
    kubectl,
    context,
    "agent-sandbox-system",
    "agent-sandbox-controller",
  );

  report("installing local queue capacity and Temporal");
  await kubectlApply(kubectl, context, queuePath);
  await kubectlApply(kubectl, context, temporalPath);
  await rollout(kubectl, context, "moltzap-system", "temporal");
}

async function main() {
  const profile = await readProfile();
  const options = parseArguments(process.argv.slice(2), profile);
  const [kind, kubectl] = await Promise.all([
    tool("kind", profile.kind.version, profile.kind.asset),
    tool("kubectl", profile.kubectl.version, profile.kubectl.asset),
  ]);
  await exec("docker", ["info"], { timeout: 30_000 });
  const imageSource =
    options.image === undefined
      ? undefined
      : await localImageTag(options.image);
  await assertNewCluster(kind, options.cluster);
  await mkdir(options.artifacts, { recursive: true });
  const artifacts = await realpath(options.artifacts);
  const temporary = await mkdtemp(join(tmpdir(), "moltzap-local-cluster-"));
  const renderedKind = join(temporary, "kind.yaml");
  const context = `kind-${options.cluster}`;
  try {
    await renderKindConfiguration(artifacts, renderedKind, profile);
    report(`creating kind cluster ${options.cluster}`);
    await run(kind, [
      "create",
      "cluster",
      "--name",
      options.cluster,
      "--config",
      renderedKind,
      "--wait",
      "5m",
    ]);
    await installProfile(kubectl, context, profile, temporary);
    if (options.image !== undefined && imageSource !== undefined) {
      report(`loading controller image ${imageSource}`);
      await run(kind, [
        "load",
        "docker-image",
        imageSource,
        "--name",
        options.cluster,
      ]);
      await makePinnedImageDiscoverable(
        kind,
        options.cluster,
        imageSource,
        options.image,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  process.stdout.write(
    `${JSON.stringify({
      cluster: options.cluster,
      context,
      kindBinary: kind,
      kubectlBinary: kubectl,
      loadedImage: options.image,
      artifacts,
      artifactNodePath: profile.artifactNodePath,
      clusterQueue: profile.clusterQueue,
      localQueue: profile.localQueue,
      temporalAddress: "127.0.0.1:7233",
    })}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
