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
| `@moltzap/simulator/controller` | Compose controller-loaded modules from the execution environment |

## Experiment module

A controller-loadable module exports exactly one named `runSpec`:

```ts
import { RunSpec } from "@moltzap/simulator";
import { openClawRuntime } from "@moltzap/simulator/agents";
import { Effect } from "effect";
import {
  applicationImageFromEnvironment,
  controllerServicesFromEnvironment,
} from "@moltzap/simulator/controller";

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

The controller composition entrypoint resolves the execution environment.
Kubernetes, Kueue, Sandbox, Temporal, and cloud-provider values stay outside
the public experiment definition. The controller
loads the module late and invokes `Run.execute(runSpec)` once.

Each started agent exposes three lifecycle-facing values:

- `.agent` is the Registry-issued nominal handle with the roster key and final
  `AgentId`;
- `.gateway` is that runtime's exact principal interface; and
- `.termination` observes autonomous runtime completion.

For OpenClaw, the mounted MoltZap channel plugin handles daemon messages. The
separate `.gateway` starts an OpenClaw `agent` RPC and returns its terminal
result to experiment code.

## Harvested workspace files

After the customer Effect ends, the controller stops the agent host and daemon
and reads evidence from the application container, whose entrypoint remains
available for collection. Name the files, relative
to the agent's workspace, on either runtime:

```ts
openClawRuntime({
  applicationImage,
  workspaceFiles: [{ relativePath: "CALENDAR.md", content: seed }],
  harvestWorkspaceFiles: ["CALENDAR.md"],
});
```

Each named file becomes one `AgentWorkspaceFileHarvested` record
(`moltzap.agent-workspace-file/v1`) carrying the agent, the runtime, the
relative path, and one of four outcomes: `text` with the content and its byte
length, `oversize` when the file exceeds 64 KiB, `absent` when the agent never
wrote it, or `unreadable` with the cause. Harvest follows the program event and
precedes teardown, including after interruption. Individual file-read failures
are recorded as outcomes rather than replacing the program result.
A custom container runtime takes part by setting `Application.harvest` to the
`HarvestTarget`s it wants read (`@moltzap/simulator/agents`).

The read is a plain `sh` probe (`test -f`, a size check, `cat`) executed in the
application container through `pods/exec`, so the controller's run-scoped Role
gains that verb. The probe runs with the application container's root privilege, follows
symbolic links, and checks the file before reading it, so an agent that
replaces a harvested file with a link exposes whatever that link names inside
its own container into the ledger, including the daemon's key and credential
that the agent's own process cannot read. The
container holds only what the experiment gave it, and the ledger is the
experiment's own, so that is accepted rather than guarded.

## Transcripts

Message content never enters the ledger through the fabric: the Router carries
opaque packets, and only each agent's own `moltzapd` decodes what it delivers
and sends. Set `historyExport: true` on either runtime to have that daemon
append one `HistoryExportRecord` line (the schema `@moltzap/client` exports)
per certified inbound delivery and per completed send to
`/var/run/moltzap/history.ndjson`. The file is harvested like an
experiment-declared file, under the name `moltzap-history.ndjson` with a 1 MiB
bound, so a bounded transcript lands in the ledger as one
`AgentWorkspaceFileHarvested` record whose `text` is NDJSON. The native artifact
export also retains the full history file, including when the bounded harvest
reports `oversize`. The agent-eye view
is that agent's `inbound` records; the wire view is the union of every agent's
`outbound` records, joined to recipients by `postId`.

## Fault scenarios

Experiment code owns directed-link policies and activation timing through
[`LinkController`](src/network/MODULE.md#linkcontrollerservice). Policies return
`deliver`, `drop`, `delay`, or `hold`. Holding A's messages to B lets C's messages
to B progress independently; clearing A's hold releases A's queued messages in
sender order. See the [Simulator fault boundary](../../docs/spec/layer-interfaces.md#simulator-fault-boundary)
for ordering, runtime isolation, and the distinction between fault-tolerance
evidence and Router-conformance evidence.

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

The package ships one executable, `moltzap-sim`, that submits one experiment
module through either profile:

```bash
moltzap-sim run --profile local path/to/experiment.mjs
moltzap-sim run --profile gke path/to/experiment.mjs
```

It reads the same `MOLTZAP_*` environment either way, prints exactly one
`ProfileRunResult` JSON line on stdout when the run finishes, and reports every
failure on stderr with a non-zero exit. Decode that line with the
`ProfileRunResult` schema the root exports. The repository's `local-run` and
`gke-run` Nx targets invoke the same executable.

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
[`local/README.md`](local/README.md) and [`gke/README.md`](gke/README.md),
which also cover submitting several runs at once and the admission budget
(`MOLTZAP_ADMISSION_TIMEOUT_MS`) a queued cohort waits on.

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

## Durable eval execution

The lifecycle extension exposes `evaluationCapabilities.version === 1` for
consumers that require reconnect, explicit cancellation, native artifacts and
stop-before-harvest behavior. A caller can set `MOLTZAP_RUN_ID` to a persisted
UUID before `moltzap-sim run`. Retrying that identity reconnects to the existing
Temporal execution; changed immutable inputs are rejected before provisioning.

Use `moltzap-sim resume mz-<32 hex digits>` to await the same execution, or
`moltzap-sim cancel mz-<32 hex digits>` to request cancellation. Ending a local
wait does not cancel remote work. Cancellation retries while the controller is
starting and stops retrying when that controller finishes. The final receipt records cleanup separately,
so a namespace deletion failure does not erase a completed controller result.

Mounted controller modules import composition helpers from
`@moltzap/simulator/controller`. Native logs and full history exports are retained
beside the ledger. `moltzap.agent-runtime-artifact/v1` binds each file's exact key,
SHA-256 and byte length; log bytes are streamed outside the ledger itself.
The agent entrypoint stops its host and daemon and drains output before the
controller collects final evidence. Collection has a five-minute budget. A
failed stop acknowledgement or collection timeout emits
`moltzap.runtime-evidence-collection-failed/v1`; already collected files remain
available, but consumers must treat the evidence as incomplete.

For an isolated qualification queue, set both `MOLTZAP_TEMPORAL_TASK_QUEUE` and
`MOLTZAP_RUN_WORKER_NAME` to distinct names. The latter selects separate worker
resources and selectors, preserving the default `run-worker` Deployment. Never
use a second worker name to poll an existing experiment queue with different code.
