# @moltzap/testbed

Launch and supervise a collection of agents connected through MoltZap. A
testbed owns process startup, readiness, logs, and teardown for its OpenClaw or
Nanoclaw agents.

## Install

Install the testbed and Effect, which the example imports directly. Runtime
adapters and their MoltZap channel dependencies are included:

```bash
npm install effect @moltzap/testbed
```

## Runtime versions

Testbed pins the external runtimes it automates: OpenClaw is installed at
the exact version in this package's dependencies; NanoClaw is downloaded
from the exact commit pinned by `NANOCLAW_SHA` in `src/nanoclaw-install.ts`
and paired with the exact `@moltzap/client` pinned in
`nanoclaw-assets/package.json`. Ordinary library dependencies use compatible
ranges and release independently.

## Launch an OpenClaw testbed

```ts
import { Effect } from "effect";
import {
  launchTestbed,
  type RuntimeServerHandle,
  type TestbedAgentSpec,
} from "@moltzap/testbed";

export async function launchOpenClawTestbed(
  server: RuntimeServerHandle,
  agents: ReadonlyArray<TestbedAgentSpec>,
) {
  return Effect.runPromise(
    launchTestbed({
      kind: "openclaw",
      server,
      agents,
      readyTimeoutMs: 60_000,
    }),
  );
}
```

The adapter resolves its installed OpenClaw binary and channel by default.
`openclaw.openclawBin` and `openclaw.channelDistDir` remain available as local
development overrides.

NanoClaw requires Docker and a local OneCLI gateway. On first use, testbed
downloads its pinned source revision, injects the bundled MoltZap channel, and
installs from a bundled package lock. Its bundled NanoClaw skill describes the
already-configured channel and `testbed-agent` profile without runtime setup
steps. The resulting cache and Docker image are keyed by the complete
source/assets/platform fingerprint. Each agent runs from its own temporary root
and container namespace; immutable build artifacts are shared.

Unknown conversations remain unregistered by default. Disposable evaluation
testbeds can opt into first-delivery registration with
`nanoclaw: { autoRegisterConversations: true }`.

The caller supplies a `RuntimeServerHandle` that observes when each registered
agent authenticates. A testbed currently uses one runtime kind for the whole
agent collection.

Each spawned agent receives an isolated `MOLTZAP_CONFIG_HOME` containing an
owner-only `config.json` and the requested `MOLTZAP_SERVER_URL`. The testbed
uses the valid internal profile selector `testbed-agent`; the stored
`agentName` remains the agent's network identity. See the
[configuration contract](https://github.com/chughtapan/moltzap/blob/main/docs/cli/configuration.mdx)
for the profile schema and OpenClaw account mapping.
