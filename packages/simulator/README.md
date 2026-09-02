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
| `@moltzap/simulator/network` | Use retained participant, endpoint, Router-fixture, and directed-link fault contracts |
| `@moltzap/simulator/agents` | Use container runtime descriptors and the shipped OpenClaw and NanoClaw implementations |
| `@moltzap/simulator/ledger` | Completed-ledger schemas, validation, and offline readback |

## Experiment module

A controller-loadable module exports exactly one named `runSpec`:

```ts
import { RunSpec } from "@moltzap/simulator";
import { openClawRuntime } from "@moltzap/simulator/agents";
import { Effect } from "effect";
import {
  applicationImageFromEnvironment,
  controllerServicesFromEnvironment,
} from "/opt/moltzap/dist/cluster/controller/services.js";

const alice = openClawRuntime({
  applicationImage: applicationImageFromEnvironment(),
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
  execute: ({ agents }) => Effect.succeed(agents.alice.agent.id),
});
```

The absolute cluster-services import is private to the repository-built
controller image. It keeps Kubernetes, Kueue, Sandbox, Temporal, and
cloud-provider values outside the public experiment contract. The controller
loads the module late and invokes `Run.execute(runSpec)` once.

Each started agent exposes three lifecycle-facing values:

- `.agent` is the Registry-issued nominal handle with the roster key and final
  `AgentId`;
- `.gateway` is that runtime's exact principal interface; and
- `.termination` observes autonomous runtime completion.

For OpenClaw, the mounted MoltZap channel plugin handles daemon messages. The
separate `.gateway` starts an OpenClaw `agent` RPC and returns its terminal
result to experiment code.

## Controlled endpoints

`network.endpoint(name)` attaches an experiment-controlled participant. Its
API has two operations:

- call `messages()` before traffic starts to observe every later addressed
  delivery; and
- call `send({ to, content })` with an explicit `agent:` or `group:` address.

`messages()` is a live, endpoint-wide stream. It does not replay deliveries
that arrived before subscription. Inspect each delivery's signed `address`,
`sender`, and group `members` when the experiment needs to select a particular
exchange, and run `acknowledge` after handling it.

The simulator does not open or register conversations. It does not create
per-address sockets or mailboxes. Address membership and durable delivery are
Client and daemon responsibilities; experiment code only sends and observes
their public facts.

OpenClaw and NanoClaw require explicit, digest-pinned complete agent images.
Each image owns its host, daemon, registration bootstrap, and fail-fast process
lifecycle. The simulator never substitutes a mutable or placeholder image.

Build that application image from the pinned NanoClaw source archive:

```bash
pnpm nx run workspace:openclaw-agent-image
pnpm nx run workspace:nanoclaw-agent-image
```

The command prints the immutable `pinnedImage` value accepted by the runtime.
Every image builder accepts `--repository NAME` to name the image,
`--tag TAG` to replace the content-fingerprint tag, and `--push` to push to
that repository's registry instead of loading into the local daemon; pass
them after `--`.

## Local and GKE profiles

Build the controller/support image and create the pinned local profile:

```bash
pnpm nx run workspace:simulator-controller-image
pnpm nx run @moltzap/simulator:local-cluster-create -- \
  --image CONTROLLER_IMAGE_AT_SHA256
```

Submit a module through Temporal and the local Kubernetes path:

```bash
MOLTZAP_CONTROLLER_IMAGE=CONTROLLER_IMAGE_AT_SHA256 \
MOLTZAP_APPLICATION_IMAGE=AGENT_IMAGE_AT_SHA256 \
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
pnpm nx run @moltzap/simulator:gke-terraform-check
```

These checks do not qualify a live cluster or publish the required NanoClaw
application image.
