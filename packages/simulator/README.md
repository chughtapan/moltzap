# @moltzap/simulator

Code-first experiments over containerized agent societies. Kubernetes is the
single execution backend; the repository provides local kind and GKE profiles
for the same run path.

The package owns typed definitions and lifecycle events, exact runtime-native
gateways, run evidence, Kueue cohort admission, Agent Sandbox applications, and
coarse Temporal lifecycle control. Experiment code owns completion policy,
scenarios, sweeps, and grading.

## Entry points

| Import | Purpose |
|---|---|
| `@moltzap/simulator` | Define a `RunSpec`, execute it, and consume customer run services |
| `@moltzap/simulator/agents` | Use container runtime descriptors and the shipped OpenClaw and NanoClaw implementations |
| `@moltzap/simulator/ledger` | Completed-ledger schemas, validation, and offline readback |

## Experiment module

A controller-loadable module exports exactly one named `runSpec`:

```ts
import { RunSpec } from "@moltzap/simulator";
import { openClawRuntime } from "@moltzap/simulator/agents";
import { Effect } from "effect";
import { controllerServicesFromEnvironment } from "/opt/moltzap/dist/cluster/controller/services.js";

const alice = openClawRuntime({
  tools: { deny: ["*"], exec: { mode: "deny" } },
  sandbox: { mode: "off" },
  workspaceFiles: [
    { relativePath: "IDENTITY.md", content: "You are Alice." },
  ],
});

export const runSpec = RunSpec.define({
  id: "acme.echo/v1",
  events: [],
  agents: { alice },
  cluster: controllerServicesFromEnvironment(),
  execute: ({ agents }) => Effect.succeed(agents.alice.agentName),
});
```

The absolute cluster-services import is private to the repository-built
controller image. It keeps Kubernetes, Kueue, Sandbox, Temporal, and
cloud-provider values outside the public experiment contract. The controller
loads the module late and invokes `Run.execute(runSpec)` once.

Each started agent exposes three lifecycle-facing values:

- `.agentName` is the roster-owned identity;
- `.gateway` is that runtime's exact principal interface; and
- `.termination` observes autonomous runtime completion.

NanoClaw requires an explicit digest-pinned application image implementing its
fixed one-container bootstrap and gateway contract. The simulator never
substitutes a mutable or placeholder image.

## Local and GKE profiles

Build the shared controller/support image and create the pinned local profile:

```bash
pnpm nx run workspace:simulator-controller-image
pnpm nx run @moltzap/simulator:local-cluster-create -- \
  --image CONTROLLER_IMAGE_AT_SHA256
```

Submit a module through Temporal and the local Kubernetes path:

```bash
MOLTZAP_CONTROLLER_IMAGE=CONTROLLER_IMAGE_AT_SHA256 \
MOLTZAP_TEMPORAL_ADDRESS=127.0.0.1:7233 \
pnpm nx run @moltzap/simulator:local-run -- path/to/experiment.mjs
```

The GKE profile uses the same experiment and controller contract with an
explicit kube context, artifact bucket, and configured Temporal endpoint. See
[`local/README.md`](local/README.md) and [`gke/README.md`](gke/README.md).

## Static validation

```bash
pnpm nx run @moltzap/simulator:build
pnpm nx run @moltzap/simulator:typecheck:tests
pnpm nx run @moltzap/simulator:lint
pnpm nx run @moltzap/simulator:test
pnpm nx run @moltzap/simulator:arch:check
pnpm nx run @moltzap/simulator:local-profile-check
pnpm nx run @moltzap/simulator:gke-profile-check
```

These checks do not qualify a live cluster or publish the required NanoClaw
application image.
