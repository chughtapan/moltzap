---
status: accepted
date: 2026-09-01
decision-makers: Tapan Chugh
---

# Five packages publish as one version set

Decision provenance: [publication set and version
policy](../decision-evidence/20260901-publication-set-trajectory.md#publication-set-and-version-policy),
[license and
housekeeping](../decision-evidence/20260901-publication-set-trajectory.md#license-and-housekeeping),
[release
mechanics](../decision-evidence/20260901-publication-set-trajectory.md#release-mechanics),
and [mechanical repository and registry
effects](../decision-evidence/20260901-publication-set-trajectory.md#mechanical-repository-and-registry-effects).

## Context and Problem Statement

The four-layer harness landed on `main` with publication switched off. The
four-layer record deferred publication membership and version coordination
(`G1-DEC-708`, the publication halves of `G1-DEC-709` and `G1-DEC-814`), the
V2-authority and six-deep-packages records repeated the deferral, and
`.github/workflows/publish.yml` was disabled until one decision existed. Two
gates encoded the deferral: the architecture boundary check required Identity
and Router to stay private, and the Client pack gate required the packed
Client to stay private.

The simulator is the product downstream benchmarks install, and its
dependency closure is `@moltzap/identity`, `@moltzap/router`, and
`@moltzap/client`. A simulator tarball whose closure is private cannot
install from npm. The registry still serves the v1 `@moltzap/protocol`,
`@moltzap/server-core`, and `@moltzap/client` as `latest`, while their sources
are deleted or replaced; the provenance ledger records the exact registry
state at admission. Package manifests disagreed on
license, and the `v2/` directory still held the constitution, a duplicate
wire-version file, and inputs no record cited.

## Decision Outcome

Chosen: **five packages publish to npm as one calendar version set, and
`@moltzap/nanoclaw-channel` and `@moltzap/evals` stay private.**

### Publication set

`@moltzap/identity`, `@moltzap/router`, `@moltzap/client`,
`@moltzap/openclaw-channel`, and `@moltzap/simulator` are public npm packages.
`@moltzap/evals` and `@moltzap/nanoclaw-channel` are private workspace products
and are never published: the NanoClaw adapter exports nothing and reaches its
host through the image build, so publication would buy a consumer nothing. No
other package is added to the set by this record.

### One version

Every release carries one version, `YYYY.MDD.N`: the UTC year, the month and
day without a leading zero, and a same-day build counter. The counter is one
past the highest that any of the five packages has published for that day or
that a `v<version>` release tag already claims, so one string is written into
all five manifests and published without colliding on any of them. Each packed manifest pins its workspace siblings to that exact version,
so a consumer who installs one package resolves the closure the same release
built, never a mix of releases.

The package version is a release namespace of its own. It is independent of
the wire compatibility value `MOLTZAP_VERSION`, the MCP revision, and every
persisted-schema version; advancing one never advances another.
`packages/identity/src/version.ts` is the sole owner of the wire value.

### Release path

Releases run from `main` through `.github/workflows/publish.yml`, triggered
manually. One run computes the version, writes it into the five manifests,
builds, proves the packed closure installs, pushes the simulator controller,
OpenClaw, and NanoClaw images tagged with the version to Artifact Registry
(reusing an image an earlier attempt pushed for the same version from the
same source revision rather than rebuilding), records the image digests in
`packages/simulator/gke/README.md`, regenerates documentation,
stamps `CHANGELOG.md`, commits `chore(release): moltzap@<version>`, and
publishes every package not yet on npm at that version with provenance. Once
the release commit is on `main`, every rerun converges on that version, its
recorded digests, and that commit. Before the release commit exists, a rerun
on the same UTC day recomputes the same version and reuses the images an
earlier attempt pushed for it; a rerun on a later UTC day mints that day's
version and rebuilds, because the packed workspace inside each image carries
the stamped version. A run dispatched with `start_new_version` abandons an
incomplete release commit and mints the next version from the tip. Only one
release runs at a time, and only from the tip of `main`. The workflow
authenticates to Google Cloud through Workload Identity Federation, whose
trust admits only this workflow on `main`, and to npm through trusted
publishing; the only stored secret is the release App's private key, which
signs the one push to `main`.

### License

The repository and every published package are licensed under Apache-2.0.
Releases published before this record keep the license their published
manifests declared and are not relicensed: the `@moltzap/protocol`,
`@moltzap/server-core`, `@moltzap/client`, and `@moltzap/openclaw-channel`
manifests declared Apache-2.0 while the repository `LICENSE` and the
`@moltzap/simulator` manifest were MIT.

### Deprecations

`@moltzap/protocol` and `@moltzap/server-core` are deprecated on npm in
full. Every `@moltzap/client` release published before this record carries
the v1 API and is deprecated. Every `@moltzap/simulator` and
`@moltzap/openclaw-channel` release published before this record predates the
cutover and is deprecated. The provenance ledger's registry observation names
the last such version of each; the ledger records that no source event
selected the `@moltzap/client` deprecation, so its attribution is the
decision-maker's admission of this record.

### Retired directory

The `v2/` directory is retired. The constitution is `docs/vision.md`; the
inputs and drafts that decision records cite live under
`docs/decision-evidence/inputs/` and `docs/decision-evidence/drafts/`;
uncited inputs are deleted; `v2/VERSION` is deleted in favour of the
Identity-owned literal.

### What this record resolves

This record resolves `G1-DEC-708` and the publication halves of `G1-DEC-709`
and `G1-DEC-814` in
[`20260811-four-layer-endpoint-replicated-harness.md`](./20260811-four-layer-endpoint-replicated-harness.md),
and the publication deferrals in
[`20260729-v2-authority-lives-with-v2.md`](./20260729-v2-authority-lives-with-v2.md)
and
[`20260728-six-deep-packages-one-version.md`](./20260728-six-deep-packages-one-version.md).
It changes no other outcome of those records. The seven-package dependency
graph, the public boundaries, and the layer contracts in
`docs/spec/layer-interfaces.md` are unchanged; that chapter's `Publication
and versions` section is the normative owner of the rules above.

## Consequences

- `scripts/architecture/check-boundaries.js` fails when a published manifest
  carries `private`, when the five versions differ, when evals or the NanoClaw
  adapter is not private, or when the release workflow's package list drifts
  from the published set. The client, OpenClaw, NanoClaw, and simulator
  `test:pack` gates pack each package's own closure and prove it installs from
  tarballs with exact sibling pins and every declared executable present. The
  NanoClaw gate proves the adapter still compiles against the Client ABI in
  isolation; the image build copies its source rather than installing a
  tarball.
- A downstream consumer pins one version and one set of image digests per
  release, read from the release commit rather than a hand-edited table.
- The first release needs maintainer-held prerequisites the repository cannot
  supply: npm trusted publishers for the five packages, the release App
  credentials, and the three repository variables that the GKE Terraform
  module outputs (the Workload Identity provider, the release service
  account, and the image repository). The deprecations are run by the
  maintainer after the first release publishes.
- A push-triggered release is a later, separate change once a manual release
  has proven the prerequisites.
- External-consumer cutover remains the one open release question; it is
  named in `docs/spec/layer-interfaces.md` → Deliberate deferrals, where it
  already stood before this record, and no source event in the provenance
  ledger selects or discusses it.

## Record changelog

Point corrections that leave the Decision Outcome intact, except where a row
says otherwise.

| Date | Change |
|---|---|
| 2026-09-01 | Pre-admission review revision: the release path names the three repository variables the Terraform module outputs (provider, service account, image repository), image reuse keyed on the source revision, and the main-only serialized run. The six-package one-version Decision Outcome is unchanged. |
| 2026-09-02 | Pre-admission review revision: the counter is one past the highest published or tagged, image reuse is keyed on version and source revision, the release App key is named as the one stored secret, and `start_new_version` abandons an incomplete release. The six-package one-version Decision Outcome is unchanged. |
| 2026-09-02 | Pre-admission point corrections: the License section states the mixed pre-record license state the ledger and the release commits record instead of "MIT-licensed"; the Deprecations section names the ledger's no-source-event gap for the `@moltzap/client` deprecation; the counter wording names release tags rather than tags on `main`. The six-package one-version Decision Outcome is unchanged. |
| 2026-09-02 | Pre-admission point corrections: the Release path states that same-version convergence holds once the release commit is on `main` and within one UTC day before it, matching the workflow; the Consequences name the ledger's no-source-event gap for the retained external-consumer cutover deferral. The six-package one-version Decision Outcome is unchanged. |
| 2026-09-02 | **The Decision Outcome changed:** the publication set drops `@moltzap/nanoclaw-channel` and is five packages rather than six; the Publication set section states why. The maintainer chose to record this as a point correction rather than a supersession, departing from the decisions skill's default that a changed outcome supersedes; the departure is deliberate rather than an oversight. The filename keeps its `six-packages` identifier because admitted records are cited by path. |
| 2026-09-02 | Point corrections to the row above and to Consequences: the Consequences stated that the NanoClaw closure is proved for the image build, which is wrong — that build copies `src/channels/moltzap.ts` into NanoClaw's source tree and packs only Client, Identity and Router, so the gate's standing reason is the isolated compile against the Client ABI. The changelog preamble no longer asserts a position for the exception, and the publication-set row cites the Publication set section for its rationale rather than restating it. The five-package Decision Outcome is unchanged. |
