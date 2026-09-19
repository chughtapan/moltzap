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
| `./cluster.sh delete` | destroy the substrate, including the image repository releases record and the release identity | ~8 min |

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
`delete` does destroy the Artifact Registry repository and the release
identity below, so the image digests every release recorded stop resolving
and the next release cannot authenticate until `setup` recreates them; do not
run it while a published release still points at this profile. A deleted
Workload Identity pool and provider stay soft-deleted for thirty days, during
which `setup` cannot recreate them under the same ids: restore them with
`gcloud iam workload-identity-pools undelete`, the matching provider
undelete, and `terraform import` instead.

Resident cost with the controller up is one `e2-standard-4` node plus disks;
the zonal control plane is free. Parking the controller with `down` leaves only
storage. A run adds up to `agent_max_nodes` `e2-standard-16` for its duration,
and gives them back when it ends.

## Provisioning handoff

Initialize the [shared Terraform backend](#terraform-state) before operating an
existing cluster. A new project first creates its own state bucket and changes
the backend bucket and prefix in `terraform/versions.tf`; the backend does not
use `project_id` or `artifact_bucket_name`. Never point a fork at this project's
state.

Copy `terraform/terraform.tfvars.example`, set the Google Cloud project and a
globally unique artifact bucket, then run setup, which plans and prompts before
it creates anything. A fork also sets `github_repository` to its own
`owner/name`: the release identity below trusts only that repository, and the
default is `chughtapan/moltzap`.

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
defaults to twenty-five `e2-standard-16`. Each agent requests 1.1 CPU, 1.25 GiB
of memory, and 1 GiB of ephemeral storage alongside a smaller support
container, and CPU exhausts first at about fourteen agents per node, so
twenty-five nodes seat three hundred agents: three hundred-agent cohorts at
once, or one beside a sweep of smaller rosters.

The chart's `ClusterQueue` quota is sized against that ceiling, held below a
node's measured allocatable capacity rather than its advertised size. Kueue
admits against the quota alone, so a quota larger than the pool can deliver
produces a cohort that is admitted and then never schedulable, and the run
hangs on pending pods instead of failing. CPU is the tightest dimension. Raise
`agent_max_nodes` and the quota in `helm/profile/values.yaml` together, never
one alone.

## Terraform state

The `agentic-societies` profile uses the dedicated bucket
`gs://agentic-societies-moltzap-tfstate`, with prefix `simulator/gke` and the
default workspace. Its state object is `simulator/gke/default.tfstate`.
This bucket is separate from `agentic-societies-moltzap-ledger`. It is created
outside this Terraform module, so deleting the cluster does not delete its
state history. The [GCS backend](https://developer.hashicorp.com/terraform/language/backend/gcs)
provides state locking; keep locking enabled for plans and applies.

Operators need Application Default Credentials, the existing permissions to
manage the profile's resources, and `roles/storage.objectAdmin` on the state
bucket. Grant bucket access to existing operators only, not workload or release
service accounts. The bucket owner also needs bucket-level `roles/storage.admin`
to manage IAM and versioning; `roles/storage.objectAdmin` cannot manage the bucket.
Preserve that administration before removing automatically created project-wide
convenience bindings. State can contain sensitive resource data: retain backups
and saved plans outside Git in directories accessible only to the operator.

For the existing cluster, create `terraform/terraform.tfvars` containing:

```hcl
project_id           = "agentic-societies"
artifact_bucket_name = "agentic-societies-moltzap-ledger"
```

Then initialize and verify from the repository root:

```bash
gcloud auth application-default login
terraform -chdir=packages/simulator/gke/terraform init -input=false
terraform -chdir=packages/simulator/gke/terraform plan -input=false -detailed-exitcode
```

Exit code 0 means no changes; 2 means a proposed change, and 1 means failure.
Review any change before applying. A backend migration does not authorize
changing resources, parking controllers, or changing cluster capacity.

### One-time migration from local state

Use one migration operator and pause other Terraform operations until
verification finishes. Identify the authoritative state by its lineage, serial,
resource identities, applied configuration, and live cluster. A newer filename
or checkout alone is insufficient. Resolve configuration drift before moving
state: the configuration used for migration must plan no changes against that
state and the live resources.

1. Back up the authoritative state and its variable inputs outside every Git
   checkout, with directory mode `0700` and file mode `0600`. Record the state
   lineage, serial, resource count, and checksum without publishing its contents.
2. Create the dedicated bucket outside Terraform. If it already exists, verify
   its project, location, IAM, versioning, and public-access settings before use.

   ```bash
   gcloud storage buckets create gs://agentic-societies-moltzap-tfstate \
     --project=agentic-societies --location=us-central1 \
     --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update gs://agentic-societies-moltzap-tfstate --versioning
   gcloud storage buckets add-iam-policy-binding \
     gs://agentic-societies-moltzap-tfstate \
     --member=user:EXISTING_OPERATOR_EMAIL --role=roles/storage.objectAdmin
   gcloud storage buckets add-iam-policy-binding \
     gs://agentic-societies-moltzap-tfstate \
     --member=user:BUCKET_OWNER_EMAIL --role=roles/storage.admin
   ```

3. In the authoritative state directory, use the reviewed configuration with
   the GCS backend and run:

   ```bash
   terraform init -migrate-state
   ```

   Review the source and destination before accepting the copy. Stop if the
   destination already has a different state. Do not use `-reconfigure` to
   bypass migration or `-force-copy` to overwrite unverified remote state.
4. Pull the remote state into a private file and compare its lineage, serial,
   resource identities, and contents with the secured source backup. Verify
   bucket versioning and the created object generation. Do not print raw state.
5. From a fresh checkout of the reviewed canonical commit, with no local state
   or backend cache, supply the same variable inputs, initialize, and run a
   normal refreshed plan. Require exit code 0 before declaring migration done.
6. Retire only local state and backup files whose lineage and contents were
   verified as superseded. Inventory the other checkouts first; leave unknown
   state untouched. Retain the secured backup outside checkouts. Reinitialize
   other operator checkouts against GCS before their next operation.

Do not apply a saved resource plan during migration. If verification fails,
retain the original state and stop other Terraform operations until the
authoritative backend is resolved; do not let local and remote copies diverge.

## Temporal

`setup` applies the same experiment-grade Temporal deployment the local profile
uses, into `moltzap-system`. Production hosting and high availability remain
deliberately unselected; this is a single Deployment sized for experiments.

Nothing publishes it. `run` opens a supervised port-forward and sets
`MOLTZAP_TEMPORAL_ADDRESS` to it, replacing a dropped forward for as long as
the run lasts. An operator running `moltzap-sim run --profile gke` directly
supplies that address instead, typically from their own
`kubectl port-forward -n moltzap-system svc/temporal 7233:7233`.

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

## Published images

Release `2026.919.0` (source revision
`d935c8f6bd28f5fc421eb98773bdb2f777bfe8d9`) pushed these images. Pin a run to the digest
reference; the tag is a lookup key, not an input the profile accepts.

| Image | Tag | Digest reference |
| --- | --- | --- |
| controller | `2026.919.0` | `us-central1-docker.pkg.dev/agentic-societies/moltzap-simulator/controller@sha256:4f0c277d75229df57e0826d989f6ed9a44735814f209dd577d080ae8e47e993c` |
| openclaw-agent | `2026.919.0` | `us-central1-docker.pkg.dev/agentic-societies/moltzap-simulator/openclaw-agent@sha256:ffa49e4d1a68abf0817d5d7503b28c8d2102f76a6e26a69337856ba0a49773b3` |
| nanoclaw-agent | `2026.919.0` | `us-central1-docker.pkg.dev/agentic-societies/moltzap-simulator/nanoclaw-agent@sha256:f18d5ad801580689d05d43e2cacc84ae37a45318f90d17b22ac1fd82f7fe1ee3` |

## Release publishing

`.github/workflows/publish.yml` pushes the controller, OpenClaw, and NanoClaw
images to the `controller_repository` repository tagged with the release
version, then writes their digests into the Published images section above in
the same release commit that bumps the npm packages. The workflow
authenticates to Google Cloud with GitHub's OIDC token through Workload
Identity Federation and to npm through trusted publishing; the only stored
secret is the release App's private key, which signs the one push to `main`.

Terraform owns that identity. `setup` creates the `github-actions` pool, its
`github` provider admitting only tokens minted for `publish.yml` on this
repository's `main` branch, and the `moltzap-release` service account with
`roles/artifactregistry.writer` on the image repository. Copy the three
outputs into the repository's Actions variables before the first release:

| Terraform output | Actions variable |
| --- | --- |
| `release_workload_identity_provider` | `GCP_WORKLOAD_IDENTITY_PROVIDER` |
| `release_service_account` | `GCP_RELEASE_SERVICE_ACCOUNT` |
| `controller_repository` | `GCP_IMAGE_REPOSITORY` |

The job runs in the `release` GitHub environment, which GitHub creates on the
first run; required reviewers added to that environment gate every release.

Two more prerequisites live outside Terraform. The release commit and tag are
pushed with a GitHub App token: set `RELEASE_APP_ID` as an Actions variable and
`RELEASE_APP_PRIVATE_KEY` as an Actions secret for an App installed on this
repository with contents write access and allowed to push `main`. npm
publishes without a token, so each of the five published packages lists
`publish.yml` on this repository as a trusted publisher before the first run.

A release pushes each image under `<version>-<commit>` and then points the
`<version>` tag at that digest. A rerun on the same UTC day reuses the
`<version>-<commit>` image; a rerun on a later day mints that day's version
and rebuilds, because the packed workspace inside each image carries the
stamped version. Until the release commit is on `main` the `<version>` tag
follows the current build; after that, the digests recorded in the commit are
the release.

A release commit on `main` whose version some package still lacks on npm is
resumed by every later run. When that release can never complete, because npm
refused the tree or a package at that version was unpublished, dispatch with
**Start a new version** checked: the run leaves the release commit alone,
takes the next free version from the tip, and the maintainer deprecates
whatever the abandoned version did publish.

After the first release publishes, deprecate the retired names and the
pre-cutover releases by hand, pointing at the publication record:

```bash
npm deprecate @moltzap/protocol@"*" "Retired; see docs/spec/layer-interfaces.md#publication-and-versions"
npm deprecate @moltzap/server-core@"*" "Retired; see docs/spec/layer-interfaces.md#publication-and-versions"
npm deprecate @moltzap/client@"<=2026.812.0" "v1 API; install the current one-version set"
npm deprecate @moltzap/simulator@"<=2026.811.0" "Pre-cutover; install the current one-version set"
npm deprecate @moltzap/openclaw-channel@"<=2026.811.0" "Pre-cutover; install the current one-version set"
```

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

`./cluster.sh publish-image` builds with `--push` and prints only the digest
reference the registry assigned, so it can be assigned directly:

```bash
MOLTZAP_CONTROLLER_IMAGE="$(packages/simulator/gke/cluster.sh publish-image)"
```

## Running from npm

A consumer that installs `@moltzap/simulator` submits with the package's
executable rather than a checkout; the environment contract is the same one
`cluster.sh run` assembles:

```bash
kubectl port-forward -n moltzap-system svc/temporal 7233:7233 &
MOLTZAP_KUBE_CONTEXT=EXPLICIT_KUBE_CONTEXT \
MOLTZAP_GKE_ARTIFACT_BUCKET=PROFILE_ARTIFACT_BUCKET \
MOLTZAP_TEMPORAL_ADDRESS=127.0.0.1:7233 \
MOLTZAP_CONTROLLER_IMAGE=REGISTRY/CONTROLLER@sha256:DIGEST \
MOLTZAP_SUPPORT_IMAGE=REGISTRY/CONTROLLER@sha256:DIGEST \
MOLTZAP_APPLICATION_IMAGE=REGISTRY/OPENCLAW-AGENT@sha256:DIGEST \
moltzap-sim run --profile gke path/to/experiment.mjs
```

| variable | required | selects |
| --- | --- | --- |
| `MOLTZAP_KUBE_CONTEXT` | yes | the kubeconfig context of this cluster |
| `MOLTZAP_GKE_ARTIFACT_BUCKET` | yes | the Terraform-owned ledger bucket |
| `MOLTZAP_TEMPORAL_ADDRESS` | yes | how this host reaches Temporal |
| `MOLTZAP_TEMPORAL_CLUSTER_ADDRESS` | no | how the worker reaches Temporal, when not the in-cluster service |
| `MOLTZAP_TEMPORAL_TASK_QUEUE` | no | the run-lifecycle queue, `moltzap-simulator` by default |
| `MOLTZAP_RUN_WORKER_NAME` | no | the worker resource and access identity, `run-worker` by default; use a distinct task queue for isolation |
| `MOLTZAP_RUN_ID` | no | a persisted UUID for reconnecting to the same execution; changed immutable inputs are rejected |
| `MOLTZAP_CONTROLLER_IMAGE` | yes | the digest-pinned controller image |
| `MOLTZAP_SUPPORT_IMAGE` | no | the Sandbox initializer image, the controller image by default |
| `MOLTZAP_APPLICATION_IMAGE` | when the module reads it | the digest-pinned complete agent image |
| `MOLTZAP_STARTUP_TIMEOUT_MS` | no | how long an admitted cohort may take to become ready |
| `MOLTZAP_ADMISSION_TIMEOUT_MS` | no | how long the queue may hold the cohort, one hour by default |
| `MOLTZAP_COHORT_SIZE` | no | the roster size of a run-sized experiment, two by default |
| `MOLTZAP_TEMPORAL_NAMESPACE` | no | the Temporal namespace, `default` by default |
| `MOLTZAP_FORCE_WORKER_ROLL` | no | exactly `1` to accept rolling the worker over its open runs |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | when a model needs one | forwarded to containers whose model id names that provider |
| `CLAUDE_CODE_OAUTH_TOKEN` | when an OpenClaw runtime selects `agentRuntime: "claude-cli"` | a `claude setup-token` value; the pod binds it to Claude Code through an OpenClaw token profile, never through OpenClaw's own Anthropic client |
| `CODEX_AUTH_JSON` | when an `openai/` model runs on a ChatGPT plan | the contents of `~/.codex/auth.json`, written to `$HOME/.codex/auth.json` in the pod; export it as `CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)"` after `codex login status` reports a ChatGPT login |

Each credential is read as the variable's value; an empty value is absent.
An agent runs on one credential per provider: with both `OPENAI_API_KEY` and
`CODEX_AUTH_JSON` exported, the controller refuses to start an `openai/` agent,
and it refuses an agent whose requested credentials the run holds none of.
Either refusal happens before that agent's Secret is created, fails the run, and
is recorded as `moltzap.agent-runtime-start-failed/v1`. The names the cluster
forwarded to each agent are recorded on the ledger's
`moltzap.agent-runtime-ready/v1` event; values are never recorded. A pod never
refreshes a copied login: a Codex access token lasts about ten days, and a
setup-token about a year, so refresh on the submitting host and resubmit.
Every credential kind is present in Temporal workflow history and in the
controller Job's environment for the life of the run.

The experiment module may import only what the controller image ships:
`@moltzap/{simulator,client,identity,router}`, `effect`, and
`@moltzap/simulator/controller`. Bench-specific code is
inlined in the `.mjs` or runs outside against the exported ledger. The
submitter's stdout is one `ProfileRunResult` line; everything else goes to
stderr. The exit status is the other half of that contract:

| Exit | Meaning |
|---|---|
| `0` | the result line was printed; it carries the run's own outcome |
| `1` | the submission failed before or after the run; stderr says why |
| `130`, `143` | interrupted by `SIGINT` or `SIGTERM` before a result line; stderr names the signal |

A consumer that sees exit `0` with no result line is reading a submitter built
before this table existed and should treat it as a failure.

## Parallel submissions

Every run namespaces its own Kubernetes objects, and the run worker serves the
queue with the Temporal SDK's default concurrency, so submitting several
experiments at once is ordinary. `ClusterQueue/moltzap` admits cohorts in
FIFO order against the agent pool's quota; a cohort that does not fit waits
in the queue. That wait is measured against `MOLTZAP_ADMISSION_TIMEOUT_MS`,
not the startup budget: a queued cohort has not started, so an hour of queue
time is the default and `MOLTZAP_STARTUP_TIMEOUT_MS` begins only once Kueue
admits it.

Three rules bound how wide to go. Concurrent submitters sharing a worker must
share one controller image: a submission installs the run worker for the image it
names, and a different image would roll the worker out from under every run
it is heartbeating, so the submitter refuses that install while runs are open
(wait for them, or set `MOLTZAP_FORCE_WORKER_ROLL=1` to accept losing them).
The refusal lives in the submitter, so a submitter built before it existed
still rolls the worker and interrupts every run in flight. Lanes that need
different controller images must use distinct `MOLTZAP_RUN_WORKER_NAME` and
`MOLTZAP_TEMPORAL_TASK_QUEUE` values, or run sequentially. Never attach a second
worker with different code to an existing experiment queue.
The submitter package and the controller image must also come from
one revision: the install applies the worker's ClusterRole from the
submitter's own manifests, so an older submitter narrows the role a newer
controller needs and every lane's next run fails to create its Role until a
matching submitter re-applies. A release couples the published npm version
to the published images table for exactly that reason. And every run keeps a
Registry, a Router, and a controller Pod on the single `e2-standard-4` system
node, so about eight runs at once is the practical ceiling; four is a sound
default.

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

Runtime evaluations are owned and run by a separate private eval monorepo,
which selects this profile through the published Simulator API. Do not claim live
qualification until completed ledgers and native artifacts are readable in the
artifact bucket, run-owned Kubernetes residue is zero, and the exact source,
package, and image identities are retained with the qualification results.

Static validation does not contact Google Cloud or a Kubernetes cluster;
`gke-terraform-check` formats, initialises without a backend, and validates
the Terraform module:

```bash
pnpm nx run @moltzap/simulator:gke-profile-check
pnpm nx run @moltzap/simulator:gke-terraform-check
```

Upstream contracts used here:

- [Kueue v0.17 installation](https://kueue.sigs.k8s.io/v0.17/docs/installation/)
- [Agent Sandbox v0.5.4](https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v0.5.4)
- [GKE Cloud Storage FUSE CSI setup](https://cloud.google.com/kubernetes-engine/docs/how-to/cloud-storage-fuse-csi-driver-setup)
- [GKE Workload Identity principal identifiers](https://cloud.google.com/iam/docs/principal-identifiers)
