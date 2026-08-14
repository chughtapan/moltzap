import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  normalizeContainerdReference,
  parseArguments,
  renderKindConfiguration,
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
  assert.match(kind, /hostPort: __MOLTZAP_TEMPORAL_HOST_PORT__/);
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

test("local clusters can select a non-conflicting Temporal host port", () => {
  assert.equal(
    parseArguments(["--temporal-port", "17233"], {
      clusterName: "moltzap-simulator",
    }).temporalPort,
    17_233,
  );
  assert.throws(
    () =>
      parseArguments(["--temporal-port", "70000"], {
        clusterName: "moltzap-simulator",
      }),
    /--temporal-port must be an integer from 1024 to 65535/,
  );
});

test("rendered kind configuration resolves every profile token", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "moltzap-kind-render-test-"));
  try {
    const destination = join(temporary, "kind.yaml");
    const profile = JSON.parse(await read("profile.json"));
    await renderKindConfiguration(
      "/tmp/moltzap-artifacts",
      17_233,
      destination,
      profile,
    );
    const rendered = await readFile(destination, "utf8");

    assert.doesNotMatch(rendered, /__MOLTZAP_[A-Z_]+__/);
    assert.match(rendered, /hostPort: 17233/);
    assert.equal(
      rendered.match(/hostPath: "\/tmp\/moltzap-artifacts"/g)?.length,
      3,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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

test("the end-to-end run sizes its roster from the run rather than the file", async () => {
  const endToEnd = await read("end-to-end.mjs");

  assert.match(endToEnd, /export const runSpec = RunSpec\.define/);
  assert.match(endToEnd, /controllerServicesFromEnvironment\(\)/);
  // The count is an input, so the module names no cohort size of its own and
  // one file covers two agents and a hundred alike.
  assert.match(endToEnd, /cohortSizeFromEnvironment\(\)/);
  assert.match(endToEnd, /length: AGENTS/);
  assert.doesNotMatch(endToEnd, /agent\d+:/);
  // Nothing is sent: a large cohort answering measures the model provider.
  assert.doesNotMatch(endToEnd, /conversation\.send/);
  assert.doesNotMatch(endToEnd, /\.gateway\.agent\(/);
  assert.match(endToEnd, /sandbox: \{ mode: "off" \}/);
  assert.match(endToEnd, /deny: \["\*"\]/);
});

test("local cluster makes the pinned controller image discoverable", async () => {
  const setup = await read("../scripts/local-create-cluster.mjs");
  assert.match(setup, /makePinnedImageDiscoverable/);
  assert.match(
    setup,
    /\.replaceAll\(ARTIFACT_TOKEN,\s*JSON\.stringify\(artifacts\)\)/,
  );
  assert.match(
    setup,
    /\.replaceAll\(TEMPORAL_HOST_PORT_TOKEN,\s*String\(temporalHostPort\)\)/,
  );
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
