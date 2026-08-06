# Hosted Phoenix

Terraform for the Arize Phoenix instance that the evaluation publisher writes
to. It is a Cloud Run service on a Cloud SQL Postgres database, authenticated
from its first revision, in the same project as everything else this repository
provisions.

This is the destination of `pnpm nx run @moltzap/evals:publish`. Nothing else in
the repository depends on it, and the publisher reaches it over plain HTTPS, so
the module owns no TypeScript and the package owns no Terraform beyond it.

## Why here and not under the GKE profile

`packages/simulator/gke` provisions a cluster whose lifecycle is deliberately
short. `cluster.sh down` parks it and `cluster.sh delete` destroys it, and both
are routine — the profile's own README describes deletion as an ordinary
operation costed at about eight minutes. Published dashboards are the opposite:
they are the retained result of a run, and they are read long after the cluster
that produced them is gone.

Filing this beside that cluster's Terraform would put the two on one shelf and
invite one `terraform destroy` to take both. It also lives in the wrong package:
`PHOENIX_HOST` and `PHOENIX_API_KEY` are read by `packages/evals/src/phoenix.ts`
and by nothing in the simulator. The layout mirrors the GKE profile's shape —
a named directory holding a README and a `terraform/` root — one package over,
where the consumer of the contract lives.

## Why Cloud Run

Phoenix could run on the GKE cluster. It should not, for the same reason it is
not filed there: an in-cluster deployment is destroyed with the cluster, and
would have to be restored, re-seeded, and re-pointed every time a qualification
run recycled the substrate. A dashboard that disappears whenever the thing it
describes is torn down is not a dashboard.

Cloud Run is the smallest thing that survives that. It has no cluster to keep
alive between runs, it scales to a single instance, and the state that actually
matters is in Cloud SQL rather than in the compute at all. The service can be
deleted and re-applied without touching the data.

## Why not Phoenix Cloud

Two reasons, and the second is decisive.

Evaluation data would leave the project. The whole arrangement here — a
dedicated project, a private database, secrets that never leave Secret Manager —
exists so that run evidence stays inside a boundary that can be reasoned about.
Managed hosting moves it outside for a convenience this module does not need.

More concretely, the publisher cannot authenticate to it. `phoenix.ts` builds
its client with `Authorization: Bearer <PHOENIX_API_KEY>`. Phoenix Cloud expects
its own `api_key` header style. Pointing the existing publisher at managed
hosting would require changing the client, and this workstream deliberately
touches no TypeScript.

## What the publisher needs

Two environment variables, both derived from a single apply:

```bash
PHOENIX_HOST="$(terraform -chdir=packages/evals/phoenix/terraform output -raw service_url)"
PHOENIX_API_KEY=…                 # created in the Phoenix UI, see below
```

`PHOENIX_HOST` is the Cloud Run origin. `PHOENIX_API_KEY` is a Phoenix API key
and is deliberately not a Terraform output: keys are created in the application,
against a named account, and can be revoked there without an apply.

`PHOENIX_HOST` means two different things depending on which side of the wire
reads it. To the publisher it is the origin to call. To the Phoenix server it is
the address to bind, which is why the service does not set it — the container
keeps the default `0.0.0.0` and sets only `PHOENIX_PORT`. Do not copy the
publisher's value into the service.

## The account model

Authentication is on in the first revision. `PHOENIX_ENABLE_AUTH` and
`PHOENIX_SECRET` are set before the service ever answers a request, so there is
no window during which an unauthenticated Phoenix is reachable, and no later
migration from open to closed that someone can forget to perform.

Phoenix bootstraps one account, `admin@localhost`, whose initial password is
normally the literal string `admin`. This module overrides it with a generated
password held in Secret Manager, so the well-known default is never valid:

```bash
gcloud secrets versions access latest \
  --project PROJECT_ID --secret moltzap-phoenix-admin-initial-password
```

That password is a bootstrap credential, not a shared one. Sign in with it,
change it immediately, and then create a **named account per person** from the
admin settings page. Everyone reading dashboards gets their own login and their
own API keys. A password passed around a team cannot be revoked for one person,
does not say who published an experiment, and survives their departure.

The strong password policy is enabled, so the accounts created that way must
carry a real password rather than a memorable one.

`PHOENIX_ADMIN_SECRET` is not set, and should not be. It is a standing bearer
token that authenticates as the first system user, which would hand every holder
of one string full administrative access with no name attached to it and no way
to revoke one holder. Named accounts with their own keys cost one page of
clicking and are revocable individually.

## Applying

```bash
cp packages/evals/phoenix/terraform/terraform.tfvars.example \
   packages/evals/phoenix/terraform/terraform.tfvars
# set project_id

terraform -chdir=packages/evals/phoenix/terraform init
terraform -chdir=packages/evals/phoenix/terraform apply
```

The first apply enables five APIs, so it may need to be run twice on a project
where they were not already on — Google reports a service as enabled before it
is uniformly usable, and the Cloud Run service agent that pulls images is
created as a side effect of enabling `run.googleapis.com`.

First start is slow. Phoenix runs its full migration set against an empty
database before the port answers, which is why the startup probe allows five
minutes.

Then take ownership:

```bash
terraform -chdir=packages/evals/phoenix/terraform output admin_bootstrap
```

## Destroying

The Cloud SQL instance and the Cloud Run service both refuse to be destroyed
while `deletion_protection` is on, which is the default here — the point of the
module is that this data outlives the cluster, so the default is the opposite of
the GKE profile's. Removing it is a deliberate, separate step:

```bash
terraform -chdir=packages/evals/phoenix/terraform apply -var deletion_protection=false
terraform -chdir=packages/evals/phoenix/terraform destroy
```

Cloud SQL reserves a deleted instance's name for roughly a week, so an immediate
re-apply under the same `name_prefix` will fail. Take a final export first if the
dashboards matter; `destroy` does not.

## How it is put together

**Image.** `phoenix_image` is a Docker Hub repository path pinned by digest, and
a `validation` block rejects anything ending in a tag. It is mirrored through an
Artifact Registry remote repository rather than pulled from Docker Hub directly,
which is what Google recommends for images that are not Docker Official or
Sponsored OSS. The digest survives the mirror, so the reference still names
exactly one image. Cloud Run pulls it as its own service agent, not as the
runtime identity, which is why the repository grant names
`service-PROJECT_NUMBER@serverless-robot-prod.iam.gserviceaccount.com`.

**Database.** Cloud Run mounts the Cloud SQL Auth proxy socket at
`/cloudsql/INSTANCE_CONNECTION_NAME` through a `cloud_sql_instance` volume — the
`google_cloud_run_v2_service` spelling of the `run.googleapis.com/cloudsql-instances`
annotation, same connector, same socket. The instance declares no authorized
network and never should: reaching it is an IAM decision, granted by
`roles/cloudsql.client` on the runtime service account, and the proxy encrypts
and authenticates independently of any address allowlist.

The connection string is the one detail here worth reading closely:

```
postgresql://phoenix:PASSWORD@/phoenix?host=/cloudsql/PROJECT:REGION:INSTANCE
```

The authority is empty and the socket directory is a query parameter. Phoenix
builds its engine with SQLAlchemy, which preserves query parameters and hands
`host` to asyncpg, and asyncpg reads a leading slash as a Unix socket directory.
Putting the path in the host slot instead does not work, because the instance
connection name contains colons that are then read as a port — which is also why
the `PHOENIX_POSTGRES_HOST` family cannot be used here. That family interpolates
its host into the authority directly, so it can address a TCP endpoint and
nothing else.

This was verified against the pinned image before it was written down: Phoenix
run against a Postgres reachable only through a socket directory named
`/cloudsql/my-proj:us-central1:phoenix-test` completed its migrations and
created its full schema over that socket.

**Secrets.** The database password, the JWT signing secret, and the initial
admin password are generated by `random_password` and stored in Secret Manager,
and the service reads all three through `secret_key_ref` rather than as
plaintext environment variables. Access is granted per secret, so the runtime
identity can read these three and nothing the project acquires later.

The database password is not stored a second time on its own. It exists inside
`moltzap-phoenix-database-url`, and giving one credential two homes means a
rotation that updates one and not the other. Read it out of the URL when a human
needs it.

The generated values are in Terraform state in plaintext. That is inherent to
generating them in Terraform, and passing them in as variables instead would put
them in state too. What follows from it is that the state is itself a secret:
keep it in a remote backend with restricted access rather than on a laptop. The
alternative — creating the secrets out of band and having Terraform reference
them by name — keeps state clean at the cost of a manual step before the first
apply, and is a reasonable trade to make later.

**Hardening.** The image's agent assistant is disabled. It can execute shell
commands and reach the network from inside the container, is on by default, and
nothing here uses it; leaving it enabled on an internet-reachable service would
be an unforced error. Usage telemetry is off, which is consistent with the
reason for self-hosting at all. Session cookies require TLS, which Cloud Run
serves exclusively.

`PHOENIX_CSRF_TRUSTED_ORIGINS` is not set, because the service URL does not
exist until the service does. If the browser UI reports a CSRF failure on
sign-in, set it to the `service_url` output in a follow-up apply.

**Ingress.** `allUsers` holds `roles/run.invoker`, which is a requirement rather
than a shortcut. Cloud Run's IAM authentication claims the `Authorization`
header for its own identity token, and the publisher needs that header for its
Phoenix bearer key; both cannot own it. Phoenix's own authentication is
therefore the access control, which is why it is enabled before the first
revision serves anything. Setting `allow_public_invoker = false` locks out the
publisher as well as everyone else. A project under a domain-restricted-sharing
org policy will reject the `allUsers` grant, and needs an exception or an
internal ingress design instead.

## Checking it

```bash
pnpm nx run @moltzap/evals:phoenix-terraform-check
```

`terraform fmt -check`, then `terraform init -backend=false`, then
`terraform validate`. It contacts no Google Cloud project and reads no
credentials, so it proves the configuration is well formed and internally
consistent and proves nothing about whether an apply would succeed. It skips
with a notice when `terraform` is not installed; it does not skip when
validation fails.

Provider resolution reaches the Terraform registry the first time it runs in a
working tree, against the committed `.terraform.lock.hcl`.

## Upstream contracts

- [Phoenix self-hosting configuration](https://arize.com/docs/phoenix/self-hosting/configuration)
- [Connect to Cloud SQL for PostgreSQL from Cloud Run](https://cloud.google.com/sql/docs/postgres/connect-run)
- [Deploy container images to Cloud Run](https://cloud.google.com/run/docs/deploying)
- [Artifact Registry remote repositories](https://cloud.google.com/artifact-registry/docs/repositories/remote-overview)
