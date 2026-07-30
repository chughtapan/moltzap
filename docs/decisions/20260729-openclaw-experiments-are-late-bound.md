---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# OpenClaw experiments are late-bound

Decision provenance: [initial trajectory](../decision-evidence/20260729-distributed-society-execution-trajectory.md#20260729-openclaw-experiments-are-late-bound) and [Agent Sandbox reconsideration](../decision-evidence/20260730-distributed-society-execution-agent-sandbox-trajectory.md).

## Context and Problem Statement

Building an OCI image for every instruction, workspace, or experiment edit
makes the registry the authoring loop. Requiring a MoltZap-specific image for
correctness would also hide a stock-image compatibility defect.

## Decision Outcome

Chosen: **a stock digest-pinned OpenClaw image is the compatibility baseline;
the MoltZap adapter, `moltzap-agentd`, bootstrap configuration, workspace,
and experiment instructions are verified late-bound artifacts**.

The direct Sandbox application container runs a mounted bootstrap command. It
verifies a content-addressed runtime bundle from the in-cluster bundle service,
installs it into the slot's persistent state root, starts OpenClaw and its
normal `startAccount` daemon supervision, and exposes local readiness only
after matching daemon discovery and the sole loopback MCP subscription. The
runtime receives experiment instructions through the MoltZap principal
channel after roster readiness; an experiment-only edit changes a bundle
digest, not an agent image digest.

OpenClaw home/workspace and committed daemon state live on the Sandbox PVC.
After a backing generation changes, bootstrap reuses verified persistent
state or reinstalls the exact bundle, then reacquires readiness. It does not
resume an interrupted model turn or live subscription. An optimized image may
preinstall the same verified material only as a cold-start optimization; the
stock path must remain conformant.

An Artifact Registry mirror may preserve the official image digest. The first
distributed conformance slice requires OpenClaw. NanoClaw distributed
conformance is deferred without changing Gate 1 mixed-runtime acceptance.

## Consequences

Experiment iteration avoids per-edit image builds while accepting bootstrap
latency. The first local compatibility gate proves the stock image can run
non-root with capability drop, persistent state, and late-bound bootstrap; a
failure is an integration bug rather than permission to require an optimized
image.

References: [OpenClaw Docker installation](https://docs.openclaw.ai/install/docker) and [OpenClaw plugins](https://docs.openclaw.ai/cli/plugins).
