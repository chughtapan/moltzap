# GKE simulator qualification profile

This is the cloud profile for the same Kubernetes execution path used by the
local simulator. It creates a regional GKE Standard cluster, a small system
pool, one fixed-size dedicated agent pool, an Artifact Registry repository,
and retained ledger storage. It installs exact Kueue and Agent Sandbox
releases with Helm and adds the profile-scoped `ClusterQueue/moltzap`.

This profile is experiment infrastructure. It does not select production
Temporal hosting, autoscaling, warm pools, multi-run policy, or a secrets and
recovery platform.

## Provisioning handoff

Copy `terraform/terraform.tfvars.example`, set the Google Cloud project and a
globally unique artifact bucket, and inspect a plan before applying it:

```bash
terraform -chdir=packages/simulator/gke/terraform init
terraform -chdir=packages/simulator/gke/terraform plan -out=qualification.tfplan
terraform -chdir=packages/simulator/gke/terraform apply qualification.tfplan
```

Terraform owns the VPC ranges required by a VPC-native cluster, regional GKE
Standard control plane, separate fixed system and agent node pools, custom node
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

The agent pool is intentionally one `e2-standard-8` node in each of exactly
three configured zones. Its conservative 20 CPU, 72 GiB memory, and 300 GiB
ephemeral-storage queue quotas are checked in together with that fixed shape.
Change them together when qualifying a different fixed cohort; autoscaling is
not part of this profile.

The profile has no Temporal deployment. Qualification supplies a test or
managed endpoint through `MOLTZAP_TEMPORAL_ADDRESS`; production hosting and
high availability remain deliberately unselected.

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
pnpm nx run @moltzap/simulator:gke-run -- packages/simulator/local/two-agent-smoke.mjs
```

The GKE entry validates `profile.json`, requires every dynamic identity above,
and invokes the existing `runTemporalSociety` worker. It does not introduce a
second workflow or simulator backend.

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

The profile is source-complete but this repository cannot prove live GKE
qualification without a caller-authorized project with billing, API enablement,
quota, and credentials. Do not claim the ADR's GKE gate until the same
two-agent smoke and one OpenClaw evaluation complete through `Run.execute`,
their ledgers are readable in the artifact bucket, and run-owned Kubernetes
residue is zero.

Static validation does not contact Google Cloud or a Kubernetes cluster:

```bash
pnpm nx run @moltzap/simulator:gke-profile-check
```

Upstream contracts used here:

- [Kueue v0.17 installation](https://kueue.sigs.k8s.io/v0.17/docs/installation/)
- [Agent Sandbox v0.5.4](https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v0.5.4)
- [GKE Cloud Storage FUSE CSI setup](https://cloud.google.com/kubernetes-engine/docs/how-to/cloud-storage-fuse-csi-driver-setup)
- [GKE Workload Identity principal identifiers](https://cloud.google.com/iam/docs/principal-identifiers)
