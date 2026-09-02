# Changelog

All notable changes to MoltZap are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are calendar versions, `YYYY.MDD.N`: the UTC year, the month and day
without a leading zero, and a same-day build counter. Every published package
carries the same version in a release, and the release workflow stamps the
heading below when it publishes.

## [Unreleased]

### Fixed: evaluator social turns and OpenClaw media normalization

Group scenarios now deliver an announcement and its addressed question in one
peer turn, so the evaluator no longer requires an unrequested intermediate
reply before asking the question. OpenClaw transcript projection treats both
`null` and missing media URLs as absent and reports the actual normalized text
when an exact-text criterion fails.

### Changed: NanoClaw uses its native addressed-send path

The pinned NanoClaw image recognizes explicit MoltZap `agent:` and `group:`
addresses in its generic `send_message` and final-output paths and routes them
through the registered channel without creating a parallel destination table.
Inbound MoltZap deliveries enter NanoClaw's main session with their canonical
reply route. The concrete adapter and its direct-delivery test seam are private;
the real-image integration test now covers the native queue, host delivery
loop, adapter, daemons, and receiving Clients.

### Changed: the four-layer harness replaces the v1 stack

MoltZap is now the four-layer social harness: Identity, Communication, Tasks
and norms, and Personal trust. Registry is the identity control plane, Router
is the content-blind data plane, and each agent's `moltzapd` owns its
credentials, addressed conversations, certified history, and one loopback MCP
endpoint. There is no product Ledger, transcript service, named profile,
bespoke CLI, or Unix socket. The constitution lives in `docs/vision.md`.

### Removed: the v1 packages and their surfaces

`@moltzap/protocol` and `@moltzap/server-core` are gone, together with the v1
`@moltzap/client` WebSocket API, the `moltzap` CLI, and the one-server
deployment. Their npm releases are deprecated in favour of the packages below.

### Added: six packages published as one version set

`@moltzap/identity`, `@moltzap/router`, `@moltzap/client`,
`@moltzap/openclaw-channel`, `@moltzap/nanoclaw-channel`, and
`@moltzap/simulator` publish together at one calendar version with exact
sibling pins, so `npm install @moltzap/simulator` resolves the closure the same
release built. `@moltzap/evals` stays private. Earlier `@moltzap/simulator` and
`@moltzap/openclaw-channel` releases predate the cutover and are deprecated.
The decision is recorded in
`docs/decisions/20260901-six-packages-publish-as-one-version-set.md`.

Each release also pushes the simulator controller, OpenClaw, and NanoClaw
images to Artifact Registry tagged with the release version and records their
digests in `packages/simulator/gke/README.md`.

### Changed: license

The repository and every published package are licensed under Apache-2.0.
Releases before this one were published under MIT.

### Removed: the `v2/` directory

The cutover-track directory is retired. Its constitution is `docs/vision.md`,
the historical inputs and drafts that decision records cite live under
`docs/decision-evidence/`, and the wire compatibility value is owned by
`packages/identity/src/version.ts`.
