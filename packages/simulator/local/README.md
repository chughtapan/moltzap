# Local Kubernetes simulator profile

This profile runs the core simulator path on three kind nodes. It installs exact
Kueue and Agent Sandbox releases, a local-only Temporal development server,
and the queue capacity consumed by complete-roster Workloads. Docker is local
cluster and image-build tooling here, not a simulator execution backend.

## Build the controller/support image

```bash
pnpm nx run @moltzap/simulator:local-controller-image
```

The builder compiles and packs the workspace packages into one local image and
prints its tag, manifest-digest identity, and fixed filesystem contract. Keep
the printed `pinnedImage`: cluster setup finds and loads its local tag, then
adds that digest identity in containerd. The local submitter uses the same
pinned value as `MOLTZAP_CONTROLLER_IMAGE`.

The controller and Sandbox initializer use the same image:

- controller main: `/opt/moltzap/dist/cluster/controller/main.js`;
- private infrastructure:
  `/opt/moltzap/dist/cluster/controller/services.js`;
- bootstrap CLI: `/opt/moltzap/dist/cluster/bootstrap.js`;
- OpenClaw plugin overlay: `/opt/moltzap/application-overlay`.

## Create the cluster

The setup script uses Docker for kind. It downloads pinned kind and kubectl
binaries into the ignored `local/.tools/` directory and verifies their SHA-256
checksums before use.

```bash
pnpm nx run @moltzap/simulator:local-cluster-create -- \
  --artifacts "$PWD/.moltzap/local-artifacts" \
  --image PINNED_IMAGE_FROM_BUILD_OUTPUT
```

The script refuses to replace an existing cluster. It prints a JSON handoff
containing the downloaded tool paths, kube context, local and node artifact
paths, queue names, and Temporal address. The selected local artifact directory
is mounted at `/var/lib/moltzap-artifacts` in the kind node. For each kind node,
the setup also records the loaded image under its immutable digest reference;
the kubelet never needs a registry to resolve the local controller or bootstrap
initializer.

The installed profile is:

- kind v0.31.0 with one digest-pinned Kubernetes v1.35.0 control-plane node
  and two workers;
- Kueue v0.17.8 with `ResourceFlavor/moltzap-local` and
  `ClusterQueue/moltzap`;
- Agent Sandbox v0.5.4 core controller and direct `Sandbox` API;
- Temporal CLI dev server 1.8.2 at `127.0.0.1:7233` through the kind-only
  NodePort mapping.

Each run namespace owns a `LocalQueue/society` that points to the shared
ClusterQueue. Run cleanup deletes the namespace; the ResourceFlavor,
ClusterQueue, controllers, and Temporal service remain profile-scoped.

Completed ledger files use the same relative layout expected by GKE readback:

```text
{localArtifactRoot}/{namespace}/ledger/{ledgerRef}/manifest.json
{localArtifactRoot}/{namespace}/ledger/{ledgerRef}/records.ndjson
{localArtifactRoot}/{namespace}/ledger/{ledgerRef}/completion.json
```

`end-to-end.mjs` is the repository-owned acceptance experiment, and the run
activity mounts it as the controller's experiment module. Its `runSpec` starts
digest-pinned stock OpenClaw applications with inherited auth disabled, tools
denied, and OpenClaw's nested sandbox off. Once the exact cohort is ready it
holds the society briefly and gives it back. It sends nothing and invokes no
model: a large cohort answering would measure the model provider rather than
the cluster, and the complete-roster gate has already passed by then.

The roster size is an input rather than part of the file, because the path is
the same at two agents and at a hundred and only the time to get there differs.
`MOLTZAP_COHORT_SIZE` carries it, defaulting to two:

```bash
MOLTZAP_CONTROLLER_IMAGE=PINNED_IMAGE_FROM_BUILD_OUTPUT \
MOLTZAP_TEMPORAL_ADDRESS=127.0.0.1:7233 \
pnpm nx run @moltzap/simulator:local-run -- local/end-to-end.mjs
```

The support image defaults to `MOLTZAP_CONTROLLER_IMAGE`, so this uses the same
immutable image for the controller and the Sandbox bootstrap initializer.

A larger cohort needs two things. Capacity to seat it: the GKE profile's agent
pool autoscales, so it takes sizes a local cluster generally cannot. And time to
reach it: `MOLTZAP_STARTUP_TIMEOUT_MS` is how long the controller waits for the
whole roster to be admitted and ready, and its two-minute default does not cover
provisioning nodes and pulling an image onto each one.

```bash
MOLTZAP_COHORT_SIZE=100 \
MOLTZAP_STARTUP_TIMEOUT_MS=900000 \
packages/simulator/gke/cluster.sh run \
  packages/simulator/local/end-to-end.mjs
```

Leaving the budget at its default is the failure a large cold cohort hits first,
and it reports as `agent sandbox "…" was not ready within 2m`.

The checked-in module and profile tests do not by themselves prove that a run
completed on a live cluster.

## Controller integration contract

The local profile submitter starts one Temporal workflow. Its controller
activity creates the run namespace and `LocalQueue`, mounts the experiment
module, exposes the controller's production router Service, and sets the closed
`MOLTZAP_*` environment accepted by
`controllerServicesFromEnvironment`. Ledger directories use a
run-specific child beneath the mounted artifact root; no Kubernetes or
Temporal objects enter the experiment context.

Only `kind-config.yaml` and the setup script are local-cluster-specific. The
queue manifests, controller image, experiment module contract, Temporal
workflow contract, and `Run.execute` path have the same shape as the GKE
profile.

## Static validation

```bash
pnpm nx run @moltzap/simulator:local-profile-check
```
