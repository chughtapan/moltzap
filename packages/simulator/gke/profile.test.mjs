import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const gkeRoot = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFile(join(gkeRoot, path), "utf8");

test("GKE profile selects only the accepted cloud shape", async () => {
  const profileText = await read("profile.json");
  const profile = JSON.parse(profileText);

  assert.equal(profile.apiVersion, "moltzap.gke-profile/v1");
  assert.deepEqual(profile.cluster, {
    mode: "Standard",
    topology: "regional",
    nameFromTerraformOutput: "cluster_name",
    locationFromTerraformOutput: "cluster_location",
    contextEnvironment: "MOLTZAP_KUBE_CONTEXT",
  });
  assert.deepEqual(profile.addons.kueue, {
    version: "v0.17.8",
    chart: "oci://registry.k8s.io/kueue/charts/kueue",
    chartVersion: "0.17.8",
  });
  assert.equal(profile.addons.agentSandbox.version, "v0.5.4");
  // The pin has two owners, and a tag object's own SHA is not the commit a
  // checkout lands on, so the installer is the one that must agree.
  const installerSource = await read("install-addons.sh");
  const pinned = /AGENT_SANDBOX_COMMIT="([0-9a-f]{40})"/.exec(installerSource);
  assert.ok(pinned, "the installer pins a 40-hex Agent Sandbox commit");
  assert.equal(profile.addons.agentSandbox.sourceCommit, pinned[1]);

  assert.deepEqual(profile.rosterPlacement.applyTo, [
    "aggregateWorkloadPodSets",
    "sandboxPodTemplates",
  ]);
  assert.deepEqual(profile.rosterPlacement.nodeSelector, {
    "moltzap.dev/pool": "agents",
  });
  assert.deepEqual(profile.rosterPlacement.tolerations, [
    {
      key: "moltzap.dev/agents",
      operator: "Equal",
      value: "true",
      effect: "NoSchedule",
    },
  ]);

  assert.equal(profile.images.requireDigestReference, true);
  const immutableImage = new RegExp(profile.images.digestReferencePattern);
  assert.match(
    `us-central1-docker.pkg.dev/p/r/controller@sha256:${"a".repeat(64)}`,
    immutableImage,
  );
  assert.doesNotMatch(
    "us-central1-docker.pkg.dev/p/r/controller:latest",
    immutableImage,
  );

  assert.equal(profile.temporal.mode, "configured-endpoint");
  assert.equal(profile.temporal.addressEnvironment, "MOLTZAP_TEMPORAL_ADDRESS");
  assert.doesNotMatch(profileText, /temporal(?:io)?\/.+@sha256:/i);
});

test("GKE ledger contract separates POSIX writes from retained CSI export", async () => {
  const profileText = await read("profile.json");
  const profile = JSON.parse(profileText);
  const active = profile.ledger.active;
  const retained = profile.ledger.retained;

  assert.deepEqual(active, {
    kind: "empty-dir",
    volume: { name: "ledger", emptyDir: {} },
    mountPath: "/var/lib/moltzap/ledger",
    permissionsInitContainer: true,
  });
  assert.equal(retained.kind, "gcs-fuse-csi-ephemeral");
  assert.equal(retained.bucketFromTerraformOutput, "artifact_bucket_name");
  assert.equal(retained.bucketEnvironment, "MOLTZAP_GKE_ARTIFACT_BUCKET");
  assert.equal(retained.podAnnotations["gke-gcsfuse/volumes"], "true");
  assert.equal(retained.volume.name, "artifacts");
  assert.equal(retained.volume.csi.driver, "gcsfuse.csi.storage.gke.io");
  assert.equal(retained.volume.csi.readOnly, false);
  assert.match(retained.volume.csi.volumeAttributes.mountOptions, /uid=1000/);
  assert.match(retained.volume.csi.volumeAttributes.mountOptions, /gid=1000/);
  assert.match(retained.volume.csi.volumeAttributes.mountOptions, /file-mode=/);
  assert.match(retained.volume.csi.volumeAttributes.mountOptions, /dir-mode=/);
  assert.match(retained.directoryTemplate, /\{runNamespace\}/);
  assert.deepEqual(retained.publicationOrder, [
    "manifest.json",
    "records.ndjson",
    "completion.json",
  ]);
  assert.doesNotMatch(profileText, /hostPath/);
});

test("Terraform owns one zonal Standard cluster whose agent capacity scales on demand", async () => {
  const [versions, lock, variables, main, outputs] = await Promise.all([
    read("terraform/versions.tf"),
    read("terraform/.terraform.lock.hcl"),
    read("terraform/variables.tf"),
    read("terraform/main.tf"),
    read("terraform/outputs.tf"),
  ]);
  const terraform = `${versions}\n${variables}\n${main}\n${outputs}`;

  assert.match(versions, /version\s*=\s*"= 7\.42\.0"/);
  assert.match(lock, /version\s*=\s*"7\.42\.0"/);
  assert.equal(lock.match(/"h1:/g)?.length, 4);
  assert.match(main, /resource "google_container_cluster" "simulator"/);
  assert.match(main, /location\s*=\s*var\.zone/);
  assert.match(main, /remove_default_node_pool\s*=\s*true/);
  assert.doesNotMatch(main, /enable_autopilot/);
  assert.match(main, /release_channel\s*\{\s*channel\s*=\s*"REGULAR"/s);

  const agentPool = main.match(
    /resource "google_container_node_pool" "agents" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(agentPool);
  // Idling at zero is what makes an unused profile cost nothing, and the
  // ceiling is the number the ClusterQueue quota is sized against.
  assert.match(agentPool, /initial_node_count\s*=\s*0/);
  assert.match(agentPool, /min_node_count\s*=\s*0/);
  assert.match(agentPool, /max_node_count\s*=\s*var\.agent_max_nodes/);
  assert.doesNotMatch(agentPool, /\bnode_count\s*=/);
  assert.match(agentPool, /machine_type\s*=\s*var\.agent_machine_type/);
  assert.match(agentPool, /disk_size_gb\s*=\s*var\.agent_disk_size_gb/);
  assert.match(agentPool, /local\.agent_pool_label_value/);
  assert.match(agentPool, /local\.agent_pool_taint_key/);
  assert.match(agentPool, /effect\s*=\s*"NO_SCHEDULE"/);
  assert.match(variables, /variable "zone"/);
  assert.match(variables, /variable "agent_max_nodes"/);
  assert.match(variables, /variable "agent_machine_type"/);
  assert.match(variables, /variable "agent_disk_size_gb"/);

  for (const resource of [
    "google_artifact_registry_repository",
    "google_storage_bucket",
    "google_service_account",
    "google_compute_network",
    "google_compute_subnetwork",
  ]) {
    assert.match(terraform, new RegExp(`resource "${resource}"`));
  }
  assert.match(main, /hierarchical_namespace\s*\{\s*enabled\s*=\s*true/s);
  assert.match(main, /uniform_bucket_level_access\s*=\s*true/);
  assert.match(main, /force_destroy\s*=\s*false/);
  assert.match(main, /public_access_prevention\s*=\s*"enforced"/);
  assert.match(main, /gcs_fuse_csi_driver_config\s*\{\s*enabled\s*=\s*true/s);
  assert.match(main, /workload_identity_config/);
  assert.match(main, /roles\/container\.defaultNodeServiceAccount/);
  assert.match(main, /roles\/artifactregistry\.reader/);
  assert.match(main, /roles\/storage\.objectUser/);
  assert.match(main, /principalSet:\/\/iam\.googleapis\.com/);
  assert.match(outputs, /output "controller_repository"/);
  assert.match(outputs, /output "artifact_bucket_name"/);
  assert.match(outputs, /output "agent_placement"/);
  assert.match(outputs, /output "agent_capacity"/);
  // The ClusterQueue quota has one owner, the profile chart. Restating it here
  // gave the same number two owners, and the copies drifted apart unnoticed.
  assert.doesNotMatch(outputs, /queue_quota/);
  assert.doesNotMatch(outputs, /ephemeral_storage\s*=/);
});

test("Helm pins both operators and reserves the complete roster resource set", async () => {
  const [kueue, sandbox, chart, values, queue] = await Promise.all([
    read("helm/kueue-values.yaml"),
    read("helm/agent-sandbox-values.yaml"),
    read("helm/profile/Chart.yaml"),
    read("helm/profile/values.yaml"),
    read("helm/profile/templates/queue.yaml"),
  ]);

  assert.match(kueue, /repository: registry\.k8s\.io\/kueue\/kueue/);
  assert.match(kueue, /tag: v0\.17\.8/);
  assert.match(kueue, /moltzap\.dev\/pool: system/);
  assert.match(sandbox, /agent-sandbox-controller/);
  assert.match(sandbox, /tag: v0\.5\.4/);
  assert.match(sandbox, /namespace:\n\s+create: false/);
  assert.match(sandbox, /extensions: false/);
  assert.match(sandbox, /moltzap\.dev\/pool: system/);
  assert.match(chart, /name: moltzap-simulator-gke-profile/);

  assert.match(values, /key: moltzap\.dev\/pool\n\s+value: agents/);
  assert.match(values, /key: moltzap\.dev\/agents/);
  assert.match(queue, /apiVersion: kueue\.x-k8s\.io\/v1beta2/g);
  assert.match(queue, /kind: ResourceFlavor/);
  assert.match(queue, /kind: ClusterQueue/);
  assert.match(queue, /nodeLabels:/);
  assert.match(queue, /nodeTaints:/);
  assert.match(queue, /tolerations:/);
  for (const resource of ["cpu", "memory", "ephemeral-storage"]) {
    assert.match(queue, new RegExp(`- ${resource}`));
  }
});

test("add-on installation is explicit, pinned, and Helm-owned", async () => {
  const installer = await read("install-addons.sh");

  assert.match(installer, /\[\[ \$# -ne 1/);
  assert.equal(installer.match(/helm upgrade --install/g)?.length, 3);
  assert.equal(installer.match(/--kube-context "\$kube_context"/g)?.length, 3);
  assert.match(installer, /KUEUE_VERSION="0\.17\.8"/);
  assert.match(installer, /AGENT_SANDBOX_VERSION="v0\.5\.4"/);
  assert.match(installer, /AGENT_SANDBOX_COMMIT="[0-9a-f]{40}"/);
  assert.match(installer, /git -C "\$temporary_root" fetch[^\n]+/);
  assert.doesNotMatch(installer, /kubectl\s+apply/);
  assert.doesNotMatch(installer, /curl\s/);
  assert.doesNotMatch(installer, /temporal/i);
});

test("the GKE target enters the core Temporal path with explicit identities", async () => {
  const [packageText, entrypoint] = await Promise.all([
    read("../package.json"),
    read("../src/cluster/profiles/gke.ts"),
  ]);
  const packageManifest = JSON.parse(packageText);
  assert.equal(
    packageManifest.nx.targets["gke-run"].options.command,
    "node bin/moltzap-sim run --profile gke",
  );
  assert.equal(packageManifest.bin["moltzap-sim"], "./bin/moltzap-sim");
  assert.match(entrypoint, /runKubernetesSociety/);
  assert.match(entrypoint, /MOLTZAP_GKE_ARTIFACT_BUCKET/);
  assert.match(entrypoint, /MOLTZAP_KUBE_CONTEXT/);
  assert.match(entrypoint, /MOLTZAP_TEMPORAL_ADDRESS/);
});

test("the README describes the Temporal this profile actually installs", async () => {
  const readme = await read("README.md");

  assert.doesNotMatch(readme, /no Temporal deployment/);
  assert.doesNotMatch(readme, /cannot prove live GKE qualification/);
  // The one endpoint a reader cannot discover from any other file.
  assert.match(readme, /MOLTZAP_TEMPORAL_CLUSTER_ADDRESS/);
  assert.match(readme, /cluster\.sh publish-image/);
});
