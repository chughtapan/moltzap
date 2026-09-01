# GKE simulator qualification profile

This is the cloud profile for the same Kubernetes execution path used by the
local simulator. It creates a zonal GKE Standard cluster, a resident system
pool, an agent pool that autoscales from zero, an Artifact Registry repository,
and retained ledger storage. It installs exact Kueue and Agent Sandbox
releases with Helm and adds the profile-scoped `ClusterQueue/moltzap`.

This profile is experiment infrastructure. It does not select production
Temporal hosting, warm pools, multi-run policy, or a secrets and recovery
platform.

## Operating the cluster

`cluster.sh` covers the whole lifecycle. The verbs are split by what each one
costs, because creating the cluster is slow and keeping nodes is expensive:

| command | does | time |
| --- | --- | --- |
| `./cluster.sh setup` | create the substrate and install the add-ons | ~12 min, once |
| `./cluster.sh up` | bring the controller online | ~2 min |
| `./cluster.sh run SPEC.mjs` | submit one RunSpec | run-sized |
| `./cluster.sh publish-image` | publish the controller image and print its digest | ~3 min |
| `./cluster.sh down` | park the controller | ~1 min |
| `./cluster.sh delete` | destroy the substrate | ~8 min |

Agent nodes are not managed by any of these. That pool autoscales from zero:
Kueue admits a cohort, its pods go pending, and the autoscaler provisions nodes
to satisfy them, then reclaims them once the pool is idle. Between runs the
agent pool costs nothing.

The controller is managed, because it cannot be hosted off-cluster. Cluster
DNS, metrics, and the connectivity agents are GKE-managed and must run on a
node; Kueue and Agent Sandbox are in-cluster controllers; and the run worker
lives in the cluster so that losing the submitting process cannot strand a run.
The agent pool cannot host any of it, because its taint exists precisely to
keep everything but agents off those nodes. While the controller is parked
nothing recovers on its own, and a submission stays pending until `up`.

`down` refuses while any Kueue `Workload` is still in flight, and `delete`
refuses while the artifact bucket holds objects, since that bucket holds run
ledgers rather than cluster state. Pass `--delete-artifacts` to discard them.

Resident cost with the controller up is one `e2-standard-4` node plus disks;
the zonal control plane is free. Parking the controller with `down` leaves only
storage. A run adds up to `agent_max_nodes` `e2-standard-16` for its duration,
and gives them back when it ends.

## Provisioning handoff

Copy `terraform/terraform.tfvars.example`, set the Google Cloud project and a
globally unique artifact bucket, then run setup, which plans and prompts before
it creates anything:

```bash
packages/simulator/gke/cluster.sh setup
```

Terraform owns the VPC ranges required by a VPC-native cluster, zonal GKE
Standard control plane, separate system and agent node pools, custom node
identity, Artifact Registry repository, hierarchical Cloud Storage bucket, and
bucket IAM. It enables Workload Identity Federation and the managed Cloud
Storage FUSE CSI add-on. The dedicated cluster's workload principal receives
object access only on that bucket. Nodes receive the GKE default-node role and
read-only access only to this profile's Artifact Registry repository.

Acquire credentials with the cluster name and location outputs, then pass the
resulting explicit kube context to the add-on installer:

```bash
packages/simulator/gke/install-addons.sh EXPLICIT_KUBE_CONTEXT
```

The installer never selects the current context implicitly. It installs the
official Kueue OCI chart at `0.17.8`, the Agent Sandbox chart from the exact
`v0.5.4` source commit, and the queue chart in `helm/profile`. Agent Sandbox
extensions remain disabled because the simulator creates direct `Sandbox`
objects and does not use warm pools.

The agent pool autoscales between zero nodes and `agent_max_nodes`, which
defaults to eight `e2-standard-16`. Each agent requests 1 CPU, 1 GiB of memory,
and 1 GiB of ephemeral storage alongside a smaller support container, and CPU
exhausts first at about fourteen agents per node, so eight nodes seat the
hundred-agent cohort.

The chart's `ClusterQueue` quota is sized against that ceiling, held below a
node's measured allocatable capacity rather than its advertised size. Kueue
admits against the quota alone, so a quota larger than the pool can deliver
produces a cohort that is admitted and then never schedulable, and the run
hangs on pending pods instead of failing. CPU is the tightest dimension. Raise
`agent_max_nodes` and the quota in `helm/profile/values.yaml` together, never
one alone.

## Temporal

`setup` applies the same experiment-grade Temporal deployment the local profile
uses, into `moltzap-system`. Production hosting and high availability remain
deliberately unselected; this is a single Deployment sized for experiments.

Nothing publishes it. `run` opens a supervised port-forward and sets
`MOLTZAP_TEMPORAL_ADDRESS` to it, replacing a dropped forward for as long as
the run lasts. An operator driving `dist/cluster/profiles/gke.js` directly
supplies that address instead.

The in-cluster run worker reaches Temporal by a different route than the
operator does — a `localhost` port-forward means nothing inside a Pod — so the
worker's endpoint is configured separately:

| variable | read by | selects |
| --- | --- | --- |
| `MOLTZAP_TEMPORAL_ADDRESS` | the submitting process | how *this host* reaches Temporal |
| `MOLTZAP_TEMPORAL_CLUSTER_ADDRESS` | the worker Deployment the submission installs | how the *cluster* reaches Temporal |

`MOLTZAP_TEMPORAL_CLUSTER_ADDRESS` is optional and defaults to the in-cluster
service the local profile installs, which is the one `setup` applies here too.
Set it only when this cluster's Temporal is a different deployment; pointing it
at an address the worker Pod cannot resolve leaves submissions pending with no
error, because a worker that never connects is indistinguishable from a queue
with nothing on it.

## Immutable simulator image

Push the controller/support image built by the repository to the
`controller_repository` Terraform output. Resolve the pushed manifest digest
and pass an `@sha256:<64 lowercase hex>` reference as
`MOLTZAP_CONTROLLER_IMAGE` and `MOLTZAP_SUPPORT_IMAGE`. A mutable tag is not a
valid GKE profile input.

Select the explicit kubeconfig context and Terraform-owned bucket, then submit
the same `.mjs` RunSpec contract used by the local profile:

```bash
MOLTZAP_KUBE_CONTEXT=EXPLICIT_KUBE_CONTEXT \
MOLTZAP_GKE_ARTIFACT_BUCKET="$(terraform -chdir=packages/simulator/gke/terraform output -raw artifact_bucket_name)" \
MOLTZAP_TEMPORAL_ADDRESS=TEMPORAL_HOST:7233 \
MOLTZAP_CONTROLLER_IMAGE=REGISTRY/CONTROLLER@sha256:DIGEST \
MOLTZAP_SUPPORT_IMAGE=REGISTRY/CONTROLLER@sha256:DIGEST \
pnpm nx run @moltzap/simulator:gke-run -- local/end-to-end.mjs
```

The GKE entry validates `profile.json`, requires every dynamic identity above,
and invokes the existing `runTemporalSociety` worker. It does not introduce a
second workflow or simulator backend.

`./cluster.sh publish-image` performs the publish and prints only the digest
reference, so it can be assigned directly:

```bash
MOLTZAP_CONTROLLER_IMAGE="$(packages/simulator/gke/cluster.sh publish-image)"
```

## Private platform contract

`profile.json` is the private handoff consumed by the GKE infrastructure
Layer. It keeps platform objects outside `RunSpec` and the customer Effect and
adds only two cloud-specific projections:

- both aggregate Workload pod sets and Sandbox pod templates receive the
  dedicated agent-pool selector and toleration; and
- the controller Job mounts the Terraform-owned bucket separately from its
  active POSIX ledger.

The controller Job carries `gke-gcsfuse/volumes: "true"`, mounts the bucket at
`/var/lib/moltzap-artifacts`, and mounts a POSIX `emptyDir` at
`/var/lib/moltzap/ledger`. The simulator builds and atomically completes the
active ledger only on that POSIX volume. After it has a completed receipt, the
controller exports `manifest.json`, `records.ndjson`, and then
`completion.json` to the bucket's run-specific
`{runNamespace}/ledger/{ledgerRef}` child. Publishing the completion object
last prevents retained readback from accepting a partial export.

The active `emptyDir` is scratch space, not a recovery guarantee. Controller
or node loss before export completes remains infrastructure failure. The bucket
mount supplies uid, gid, and modes for the non-root controller; the root
initializer changes ownership only on the active POSIX volume.

Kueue's ResourceFlavor describes the dedicated pool, but the simulator uses a
direct aggregate `Workload` and later creates Sandboxes itself. The profile
therefore applies placement to both the capacity pod sets and actual Sandbox
pod templates; Kueue admission alone is not treated as placement or readiness.

## Qualification

A hundred-agent society run has completed on this profile through
`Run.execute`. That is the decision log's claim, not one a reader can check
from a checkout: the run's exported ledger is retained nowhere in the
repository, as
[the execution trajectory](../../../docs/decision-evidence/20260801-main-kubernetes-society-execution-trajectory.md)
records.

Runtime evaluations are owned and run by
[`@moltzap/evals`](../../evals/README.md), which can select this profile as its
Simulator backend. They are not cluster lifecycle commands. Do not claim live
qualification until the resulting ledgers are readable in the artifact bucket,
run-owned Kubernetes residue is zero, and that evidence is retained where a
reader can find it.

Static validation does not contact Google Cloud or a Kubernetes cluster:

```bash
pnpm nx run @moltzap/simulator:gke-profile-check
```

Upstream contracts used here:

- [Kueue v0.17 installation](https://kueue.sigs.k8s.io/v0.17/docs/installation/)
- [Agent Sandbox v0.5.4](https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v0.5.4)
- [GKE Cloud Storage FUSE CSI setup](https://cloud.google.com/kubernetes-engine/docs/how-to/cloud-storage-fuse-csi-driver-setup)
- [GKE Workload Identity principal identifiers](https://cloud.google.com/iam/docs/principal-identifiers)
