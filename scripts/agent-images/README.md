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

## Experiment variants

`build-openclaw-image.mjs` builds evaluation-only variants of the OpenClaw
image. They are not production images, release workflows never pass these
options, and each option may be removed without notice. Every option adds a
suffix to the tag, so a variant never shares a tag with the default image or
another variant.

| Option | Tag suffix | Effect in the image |
| --- | --- | --- |
| `--experiment-hide-collectives` | `hide-collectives` | Sets `MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES=true`: the message tool omits `collective` and `collectiveResponse` and refuses a send carrying either |
| `--experiment-omit-collectives-skill` | `omit-collectives-skill` | Deletes the plugin's `moltzap-collectives` skill directory |
| `--experiment-guidance-dir DIR` | `guidance-<hash>` | Installs a candidate's collectives guidance from `DIR` |

`DIR` holds either or both of these, and nothing else:

- `skill/` with a `SKILL.md`: replaces the plugin's `skills/moltzap-collectives/`
  directory wholesale, so the skill's name, description and body can all
  change. It cannot be combined with `--experiment-omit-collectives-skill`.
- `parameters.json`: `{ "collective"?: string, "collectiveResponse"?: string }`.
  Each present key replaces that message tool parameter's description; the
  schemas stay the same. The image sets
  `MOLTZAP_EXPERIMENT_GUIDANCE_PARAMETERS` to the file's path, and the plugin
  fails to load when the file is unreadable, is not that shape, or names any
  other key. The build loads the plugin once, so such a file fails the build.

`<hash>` is the first twelve hex characters of a SHA-256 over every file's
relative path and content in `DIR`, so two candidates never share a tag. The
build's JSON output records it as `guidance`.

```sh
node scripts/agent-images/build-openclaw-image.mjs \
  --experiment-guidance-dir candidates/2026-10-01-a --push
```

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
