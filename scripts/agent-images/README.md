# Agent images

This directory holds the sources and builders for the OpenClaw and NanoClaw
agent images. An image runs the host and `moltzapd` in one container; see
`shared/entrypoint.mjs` for the contract a launcher supplies. The
`workspace:openclaw-agent-image` and `workspace:nanoclaw-agent-image` Nx targets
build them locally, and `workspace:agent-images-check` runs their contract
tests. A release of this repository publishes npm packages only; see
[Published images](#published-images) for where the images come from.

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
pin a digest that `social-harness/deployment` published from this revision
before GKE qualification.

## Published images

The private [`social-harness/deployment`](https://github.com/social-harness/deployment)
repository builds and publishes the OpenClaw and NanoClaw agent images. Its
`.github/workflows/images.yml` pushes them into the experiment cluster's image
repository, and its `infra/evals` Terraform owns that repository and the
publishing identities. Take the digest to pin from that repository.

Release `2026.1001.1` (source revision
`1e8f6037aff8682a876cbf5299fafacd2268f25e`) was the last release of this
repository to push the images. Its digest references stay pullable:

| Image | Tag | Digest reference |
| --- | --- | --- |
| openclaw-agent | `2026.1001.1` | `us-central1-docker.pkg.dev/agentic-societies/moltzap-simulator/openclaw-agent@sha256:cbd435df63943d8dd1ecd05a8848a183a010e61fd817118b765491852311bfc5` |
| nanoclaw-agent | `2026.1001.1` | `us-central1-docker.pkg.dev/agentic-societies/moltzap-simulator/nanoclaw-agent@sha256:966588421efd86faa8044122ec36eb359bff9a8190062a854ed3aafd03a640ea` |
