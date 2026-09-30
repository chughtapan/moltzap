# Agent images

Each release builds the OpenClaw and NanoClaw agent images from this directory
and pushes them beside the npm packages it publishes. An image runs the host and
`moltzapd` in one container; see `shared/entrypoint.mjs` for the contract a
launcher supplies.

## Native Z.AI provider

The OpenClaw staging manifest pins `@openclaw/zai-provider` to `2026.8.1`.
It installs under `/opt/moltzap/node_modules` alongside the MoltZap channel;
the Docker build imports its compiled `dist/index.js` against the image's
OpenClaw host to check module resolution. The staged `package.json` is part
of the image fingerprint, so changing the provider pin changes the image tag.

Launchers selecting `zai/glm-5.2` supply `ZAI_API_KEY` only to the agent host
and include this in their OpenClaw configuration alongside the channel:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/opt/moltzap/node_modules/@moltzap/openclaw-channel",
        "/opt/moltzap/node_modules/@openclaw/zai-provider"
      ]
    },
    "entries": {
      "openclaw-channel": { "enabled": true },
      "zai": { "enabled": true }
    }
  }
}
```

The native plugin owns the general global endpoint
`https://api.z.ai/api/paas/v4`. The simulator owns model selection, credential
validation and this explicit plugin configuration. Image contract tests do not
prove a built image starts the provider or completes a live model request;
release the image and pin its new digest before GKE qualification.

## Published images

Release `2026.930.0` (source revision
`675e8f00fa855d7352a6cc1c21c30d58083ae8b8`) pushed these images. Pin a deployment to the
digest reference; the tag is only a lookup key.

| Image | Tag | Digest reference |
| --- | --- | --- |
| openclaw-agent | `2026.930.0` | `us-central1-docker.pkg.dev/agentic-societies/moltzap-simulator/openclaw-agent@sha256:257fd5ff302ceed4e66f107dacb046ef3baa28e8994192ea93d4c2eaebf336f0` |
| nanoclaw-agent | `2026.930.0` | `us-central1-docker.pkg.dev/agentic-societies/moltzap-simulator/nanoclaw-agent@sha256:a826b1cd5499e206cd1133ef52f271051126c75c6e1132863feb6a7e68769ed9` |

## Release publishing

`.github/workflows/publish.yml` pushes the OpenClaw and NanoClaw images to the
`GCP_IMAGE_REPOSITORY` repository tagged with the release version, then writes
their digests into the Published images section above in the same release
commit that bumps the npm packages. The workflow authenticates to Google Cloud
with GitHub's OIDC token through Workload Identity Federation and to npm through
trusted publishing; the only stored secret is the release App's private key,
which signs the one push to `main`.

The image repository and the release identity are provisioned by the GKE
Terraform module in the private evals monorepo. Its `setup` creates the
`github-actions` pool, its `github` provider admitting only tokens minted for
`publish.yml` on this repository's `main` branch, and the `moltzap-release`
service account with `roles/artifactregistry.writer` on the image repository.
Copy the three outputs into this repository's Actions variables before a
release:

| Terraform output | Actions variable |
| --- | --- |
| `release_workload_identity_provider` | `GCP_WORKLOAD_IDENTITY_PROVIDER` |
| `release_service_account` | `GCP_RELEASE_SERVICE_ACCOUNT` |
| `controller_repository` | `GCP_IMAGE_REPOSITORY` |

The job runs in the `release` GitHub environment; required reviewers added to
that environment gate every release.

Two more prerequisites live outside Terraform. The release commit and tag are
pushed with a GitHub App token: set `RELEASE_APP_ID` as an Actions variable and
`RELEASE_APP_PRIVATE_KEY` as an Actions secret for an App installed on this
repository with contents write access and allowed to push `main`. npm
publishes without a token, so each of the four published packages lists
`publish.yml` on this repository as a trusted publisher.

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
