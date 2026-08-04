import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  normalizeContainerdReference,
  retryImageDiscovery,
  selectLocalImageTag,
} from "../scripts/local-create-cluster.mjs";

const localRoot = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFile(join(localRoot, path), "utf8");

test("local profile pins every downloaded or executed artifact", async () => {
  const profile = JSON.parse(await read("profile.json"));
  assert.equal(profile.apiVersion, "moltzap.local-profile/v1");
  assert.match(profile.kind.nodeImage, /@sha256:[0-9a-f]{64}$/);
  assert.match(profile.temporalImage, /@sha256:[0-9a-f]{64}$/);
  assert.match(profile.kueue.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(profile.agentSandbox.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(profile.clusterQueue, "moltzap");
  assert.equal(profile.localQueue, "society");
  assert.equal(profile.artifactNodePath, "/var/lib/moltzap-artifacts");
  for (const tool of [profile.kind, profile.kubectl]) {
    assert.equal(Object.keys(tool.binaries).length, 4);
    for (const asset of Object.values(tool.binaries)) {
      assert.match(asset.url, /^https:\/\//);
      assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    }
  }

  const kind = await read("kind-config.yaml");
  assert.match(kind, /__MOLTZAP_ARTIFACTS__/);
  assert.match(kind, new RegExp(profile.kind.nodeImage.replaceAll(".", "\\.")));
  assert.match(kind, /containerPort: 30733/);
  assert.match(kind, /hostPort: 7233/);
  assert.match(kind, /containerPath: \/var\/lib\/moltzap-artifacts/);
  assert.equal(kind.match(/role: worker/g)?.length, 2);
  assert.equal(kind.match(/__MOLTZAP_ARTIFACTS__/g)?.length, 3);

  const temporal = await read("temporal.yaml");
  assert.match(
    temporal,
    new RegExp(profile.temporalImage.replaceAll(".", "\\.")),
  );
  assert.match(temporal, /type: NodePort/);
  assert.match(temporal, /nodePort: 30733/);
});

test("queue profile reserves every resource requested by an application", async () => {
  const queue = await read("queue.yaml");
  for (const resource of ["cpu", "memory", "ephemeral-storage"]) {
    assert.match(queue, new RegExp(`- ${resource}`));
  }
  assert.match(queue, /kind: ClusterQueue\nmetadata:\n  name: moltzap\n/);
  assert.match(queue, /apiVersion: kueue\.x-k8s\.io\/v1beta2/g);
  assert.match(queue, /name: cpu\n\s+nominalQuota: "24"/);
  assert.match(queue, /name: memory\n\s+nominalQuota: 64Gi/);
});

test("two-agent smoke sends once through one diagnostic conversation", async () => {
  const smoke = await read("two-agent-smoke.mjs");
  assert.match(smoke, /export const runSpec = RunSpec\.define/);
  assert.match(smoke, /controllerInfrastructureFromEnvironment\(\)/);
  assert.match(smoke, /network\.endpoint\("diagnostic"\)/);
  assert.match(smoke, /agents\.alice\.agent/);
  assert.match(smoke, /agents\.bob\.agent/);
  assert.equal(smoke.match(/conversation\.send/g)?.length, 1);
  assert.doesNotMatch(smoke, /\.gateway\.agent\(/);
  assert.match(smoke, /sandbox: \{ mode: "off" \}/);
  assert.match(smoke, /deny: \["\*"\]/);
});

test("ten-agent smoke exercises one complete admitted roster", async () => {
  const smoke = await read("ten-agent-smoke.mjs");
  assert.match(smoke, /export const runSpec = RunSpec\.define/);
  assert.match(smoke, /controllerInfrastructureFromEnvironment\(\)/);
  assert.equal(smoke.match(/^    agent\d{2}: runtime\(/gm)?.length, 10);
  for (let index = 1; index <= 10; index += 1) {
    const name = `agent${String(index).padStart(2, "0")}`;
    assert.match(smoke, new RegExp(`agents\\.${name}\\.agent`));
  }
  assert.equal(smoke.match(/conversation\.send/g)?.length, 1);
  assert.doesNotMatch(smoke, /\.gateway\.agent\(/);
});

test("controller image exposes the agreed controller and support layout", async () => {
  const dockerfile = await read("controller-image/Dockerfile");
  assert.match(
    dockerfile,
    /ENTRYPOINT \["node", "\/opt\/moltzap\/dist\/platform\/controller\/main\.js"\]/,
  );
  assert.match(dockerfile, /\/opt\/moltzap\/application-overlay/);
  assert.match(dockerfile, /\/opt\/moltzap\/dist/);
  assert.match(dockerfile, /node:22\.22\.0-bookworm-slim@sha256:[0-9a-f]{64}/);

  const setup = await read("../scripts/local-create-cluster.mjs");
  assert.match(setup, /makePinnedImageDiscoverable/);
  assert.match(setup, /template\.replaceAll\(ARTIFACT_TOKEN/);
  assert.match(setup, /"docker-image",\n\s+imageSource,/);
  assert.match(
    setup,
    /"ctr",\n\s+"-n",\n\s+"k8s\.io",\n\s+"images",\n\s+"tag"/,
  );
  assert.match(setup, /"--force",\n\s+"--skip-reference-check"/);
  assert.match(setup, /"crictl", "inspecti", digestReference/);
  assert.match(
    setup,
    /makePinnedImageDiscoverable\(\n\s+kind,\n\s+options\.cluster,\n\s+imageSource,\n\s+options\.image,/,
  );
});

test("controller image packages the compiled evaluation application", async () => {
  const evalPackage = JSON.parse(await read("../../evals/package.json"));
  assert.ok(
    evalPackage.files?.includes("dist"),
    "the packed evaluation package must include its compiled entrypoints",
  );

  const dockerfile = await read("controller-image/Dockerfile");
  assert.match(
    dockerfile,
    /node_modules\/@moltzap\/evals\/dist\/peer-application\.js/,
  );
});

test("controller overlay preserves runtime peers and verifies the plugin entry", async () => {
  const dockerfile = await read("controller-image/Dockerfile");
  const channelPackage = JSON.parse(
    await read("../../openclaw-channel/package.json"),
  );
  assert.doesNotMatch(dockerfile, /--omit=peer/);
  assert.match(
    dockerfile,
    /await import\("\.\/node_modules\/@moltzap\/openclaw-channel\/dist\/openclaw-entry\.js"\)/,
  );
  assert.equal(channelPackage.peerDependenciesMeta?.openclaw?.optional, true);
});

test("local image discovery retries are bounded", async () => {
  let attempts = 0;
  const pauses = [];
  await retryImageDiscovery(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("not visible yet");
      }
    },
    {
      attempts: 4,
      intervalMs: 7,
      pause: async (milliseconds) => pauses.push(milliseconds),
    },
  );
  assert.equal(attempts, 3);
  assert.deepEqual(pauses, [7, 7]);

  attempts = 0;
  await assert.rejects(
    retryImageDiscovery(
      async () => {
        attempts += 1;
        throw new Error("still missing");
      },
      { attempts: 2, intervalMs: 0, pause: async () => undefined },
    ),
    /after 2 attempts/,
  );
  assert.equal(attempts, 2);
});

test("local image aliases use Docker's normalized containerd references", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(
    normalizeContainerdReference(`controller@${digest}`),
    `docker.io/library/controller@${digest}`,
  );
  assert.equal(
    normalizeContainerdReference(`docker.io/controller@${digest}`),
    `docker.io/library/controller@${digest}`,
  );
  assert.equal(
    normalizeContainerdReference(`index.docker.io/controller@${digest}`),
    `docker.io/library/controller@${digest}`,
  );
  assert.equal(
    normalizeContainerdReference(`ghcr.io/moltzap/controller@${digest}`),
    `ghcr.io/moltzap/controller@${digest}`,
  );
  assert.equal(
    selectLocalImageTag(
      ["unrelated:latest", "controller:local"],
      `docker.io/controller@${digest}`,
    ),
    "controller:local",
  );
  assert.throws(
    () => selectLocalImageTag([], `controller@${digest}`),
    /no local repository tag/,
  );
});
