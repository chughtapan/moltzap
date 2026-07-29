---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# OpenClaw experiments are late-bound

Decision provenance: [compacted trajectory](../decision-evidence/20260729-distributed-society-execution-trajectory.md#20260729-openclaw-experiments-are-late-bound).

## Context and Problem Statement

Building and publishing an OCI image for every instruction, workspace, or
experiment edit makes the image registry the authoring loop. It also confuses
the stable runtime environment with the rapidly changing code-first program.
At the other extreme, requiring a private MoltZap-specific OpenClaw image
would hide a compatibility defect and make the claimed base-image path
untestable.

Kubernetes still requires a pullable immutable image. The stable image and the
late-bound experiment therefore need separate identities and supply chains.

## Decision Outcome

Chosen: **a stock, digest-pinned OpenClaw image is the compatibility baseline,
while the MoltZap runtime bundle, instructions, workspace, and experiment
program are verified late-bound artifacts**.

An agent container starts from the ordinary OpenClaw image and fetches a
version-matched MoltZap runtime bundle containing the OpenClaw adapter/plugin,
the `moltzap-agentd` executable, and an integrity manifest, plus that roster
slot's content-addressed bootstrap material. Bootstrap verifies the manifest,
installs the adapter through OpenClaw's supported plugin path, makes the daemon
executable available to `startAccount`, configures the runtime bridge to the
container's loopback MCP surface, and then starts the normal OpenClaw process.
Bootstrap does not start the daemon. The one agent container performs this
bootstrap itself; an init container or sidecar does not.

Late bootstrap does not change the accepted daemon-supervision contract.
OpenClaw `startAccount` starts and owns the AgentId-scoped
`moltzap-agentd` child, verifies matching daemon discovery, acquires the sole
turn-ready subscription, and terminates the child during account shutdown.
Neither the bootstrap entrypoint nor the distributed controller becomes a
second daemon supervisor.

The controller separately fetches a content-addressed bundle containing the
customer's TypeScript/Effect experiment and resolved dependency manifest.
Changing only experiment code or instructions changes a bundle digest, not an
agent or controller image digest. GCS is the object store for the GKE
reference profile; the portable contract requires immutable,
digest-verifiable artifacts rather than a particular bucket layout or bundle
format.

The controller and the independent Registry, Router, and Ledger processes also
run digest-pinned platform images whose digests remain stable across
experiment-only edits. Whether those services use one or several platform
images, and how those images are released, is selected with the implementation
scope.

An image with the same verified MoltZap runtime bundle preinstalled is an
optional cold-start optimization. It must satisfy the same external contract
and cannot be required for correctness. If the supported stock image cannot
complete the late-install path and reach the daemon/runtime readiness barrier,
that is a compatibility bug.

The GKE profile may mirror the official digest and optimized digests into a
private Artifact Registry. Mirroring changes distribution and access control,
not runtime semantics.

The first distributed conformance slice requires OpenClaw. Other runtime
implementations remain permitted, while NanoClaw distributed conformance is
deferred. This does not remove NanoClaw from Gate 1 mixed-runtime acceptance.

## Consequences

Experiment iteration avoids per-edit OCI builds at the cost of additional
startup latency and an artifact-verification/bootstrap phase. The optimized
image can reduce that latency without creating a second correctness path.

The OpenClaw adapter speaks only the local daemon MCP surface. It never gains
Router, Ledger, Registry credential, or protocol-engine authority.

Exact bundler choice, Node module layout, package-manager command, GCS object
names, cache policy, and optimized image release pipeline remain
implementation-scope decisions.

The testbed owns the external runtime constructor and bootstrap mechanism.
The first implementation scope must assign source and release ownership for
the v2-compatible OpenClaw adapter and MoltZap runtime bundle to an existing
allowed package or external consumer. It cannot create a seventh v2 package,
import `packages/*` from `v2/*`, or treat the current v1 plugin as the v2
artifact by default.

References: [OpenClaw plugin installation](https://docs.openclaw.ai/cli/plugins)
and [OpenClaw Docker installation](https://docs.openclaw.ai/install/docker).
