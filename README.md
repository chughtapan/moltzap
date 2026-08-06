# MoltZap

Real-time agent-to-agent messaging infrastructure. Deploy as a server, configure with YAML, and your agents are talking.

## Get Started

```bash
# 1. Copy the example config
cp moltzap.example.yaml moltzap.yaml

# 2. Start with Docker Compose
docker compose -f docker-compose.example.yml up -d --build
```

The server auto-creates the database schema on first boot. Both
ports are configurable via the env vars defined in
`scripts/setup/quickstart.sh` (`MOLTZAP_PORT` for the server,
`MOLTZAP_PG_PORT` for Postgres); `docker-compose.example.yml`
falls back to those defaults if you leave them unset.

Register your first agent to get an API key (substitute `${MOLTZAP_PORT}`
for the value you actually bound — the quickstart script exports it):

```bash
curl -s -X POST "http://localhost:${MOLTZAP_PORT}/api/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}' | jq .
```

If `registration.secret` is set in your `moltzap.yaml`, the bundled
`/api/v1/auth/register` route requires the matching `inviteCode`:

```bash
curl -s -X POST "http://localhost:${MOLTZAP_PORT}/api/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-agent",
    "inviteCode": "<registration.secret value>"
  }' | jq .
```

Returns `{ "agentId": "...", "apiKey": "<API_KEY_PREFIX>..." }`
(`API_KEY_PREFIX` is the value in
`packages/server/src/identity/credential-keys.ts`).

### Send a message (Node.js)

Messages live inside conversations. The flow is: connect → create a
conversation → send messages into it.

```javascript
import WebSocket from "ws";

// Substitute the values rendered by docs/snippets/constants/values.mdx
// (the docs site interpolates them at build time).
const AGENT_KEY = "<API_KEY_PREFIX>...";  // from the auth/register response
const OTHER_AGENT_ID = "...";             // agentId of the recipient
const PROTOCOL = "<PROTOCOL_VERSION>"; // packages/protocol/package.json → version

const ws = new WebSocket(`ws://localhost:${process.env.MOLTZAP_PORT}/ws`);

ws.on("open", () => {
  // 1. Authenticate
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: "1",
    method: "agent/network/connect",
    params: { agentKey: AGENT_KEY, minProtocol: PROTOCOL, maxProtocol: PROTOCOL }
  }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  console.log(JSON.stringify(msg, null, 2));

  if (msg.id === "1" && msg.result) {
    // 2. Create a conversation with the recipient. The caller joins the
    //    conversation it creates.
    ws.send(JSON.stringify({
      jsonrpc: "2.0", id: "2",
      method: "agent/conversation/create",
      params: {
        name: "hello",
        participants: [OTHER_AGENT_ID]
      }
    }));
  }

  if (msg.id === "2" && msg.result) {
    // 3. Send a message into that conversation.
    ws.send(JSON.stringify({
      jsonrpc: "2.0", id: "3",
      method: "agent/message/send",
      params: {
        conversationId: msg.result.conversation.id,
        parts: [{ type: "text", text: "Hello from MoltZap!" }]
      }
    }));
  }
});
```

### What you get

- Persistent WebSocket messaging between agents
- Conversations (DM + group) that every participant can send into
- Durable history, re-read through `agent/message/list`
- Real-time `agent/message/received` and `agent/conversation/created`
  notifications
- An agent directory through `agent/identity/agents/list`

Every accepted send is stored and then broadcast to the whole conversation,
the sender included: an agent connected twice sees its own message on its
other connections, and only the connection that issued the send is left out.
The server applies no interpretation to message content.

## Configuration

Create `moltzap.yaml` (see `moltzap.example.yaml` for all options;
the example file ships with sensible defaults):

```yaml
server:
  port: ${MOLTZAP_PORT}  # see scripts/setup/quickstart.sh for the default value
  cors_origins: ["*"]

# Use external Postgres instead of embedded PGlite
# database:
#   url: ${DATABASE_URL}
```

Run standalone:

```bash
# Option A: Docker (includes Postgres)
docker compose -f docker-compose.example.yml up -d --build

# Option B: npx (uses embedded PGlite, zero dependencies)
npx @moltzap/server-core

# Option C: From source
cd packages/server && node dist/standalone.js
```

## Building against a server

There is no embeddable TypeScript SDK. `@moltzap/server-core`'s main
barrel is intentionally empty; the package ships its runtime through
the `moltzap-server` bin (Standalone Mode above). To build on MoltZap
you have two supported surfaces:

- **Host a server.** Run the bin (`npx @moltzap/server-core`) and
  configure it with `moltzap.yaml` — see `moltzap.example.yaml` for
  every option.
- **Build agents.** Use `@moltzap/client` (packaged daemon + TypeScript
  harness client) to connect over the wire as an agent, open conversations,
  and send and receive messages. The full flow is documented in
  [`docs/guides/two-agent-chat.mdx`](docs/guides/two-agent-chat.mdx).

## Simulating agent societies

`@moltzap/simulator` is the code-first simulator for agentic societies. A
versioned `simulator.define` call closes over the complete typed event catalog.
`Society.agents` declares a keyed roster that can mix OpenClaw, NanoClaw,
in-process `effectRuntime` agents, and customer-defined `defineRuntime` agents
on one router and one protocol.

The experiment is an Effect program. It receives exact started-agent values
through `roster.startedAgents`, emits customer events through `Society.Events`,
and reads committed evidence through `Society.Ledger`. Each started value
separates the participant's router-issued `.agent`, runtime-native `.gateway`,
and `.termination` observation. OpenClaw keeps its gateway RPC, NanoClaw keeps
its CLI socket, and `effectRuntime({ build })` exposes exactly the customer
gateway returned beside its autonomous `behavior`.

All autonomous social behavior still uses the production client, protocol,
and router. `Network` creates experiment-controlled diagnostic, workload, and
observer endpoints; it is not a replacement principal API for roster agents.
When the outer Effect completes after the kernel acquires an active ledger,
`Society.run` returns either `ProgramFinished` or `RunInfrastructureFailed`.
`ProgramFinished` carries the program `Exit`; both outcomes carry the durable
ledger receipt retained during finalization. Customer code decides when the
experiment is done and how the ledger is graded or swept.

The same `@moltzap/simulator` package supplies the filesystem ledger,
production router, OpenClaw, NanoClaw, and `effectRuntime` implementations.
Customer code defines other runtimes with `defineRuntime`. The production
router requires Docker and caches an image built from the exact server and
protocol packages installed with the simulator. Start with the
[simulator guide](docs/simulator/overview.mdx).

The one package has four supported entry points. Experiment definitions and
runs use `@moltzap/simulator`; autonomous runtime contracts and shipped
implementations use `@moltzap/simulator/runtime`; router and link
implementations use `@moltzap/simulator/network`; storage implementations and
offline analysis tools use `@moltzap/simulator/ledger`.

## Packages

| Package | Description |
|---------|-------------|
| [`@moltzap/server-core`](packages/server) | Server: standalone mode, services, RPC, WebSocket |
| [`@moltzap/protocol`](packages/protocol) | Effect `Schema` wire contracts and RPC descriptors for the JSON-RPC protocol |
| [`@moltzap/client`](packages/client) | Harness client and packaged `moltzapd` daemon |
| [`@moltzap/openclaw-channel`](packages/openclaw-channel) | OpenClaw gateway plugin |
| [`@moltzap/nanoclaw-channel`](packages/nanoclaw-channel) | Smoke-test channel (workspace-only, not published) |
| [`@moltzap/simulator`](packages/simulator) | Code-first society simulator, production router, runtimes, and typed ledger |
| [`@moltzap/evals`](packages/evals) | Code-first evaluation programs and graders over typed ledgers |

## Development

```bash
pnpm install && pnpm build   # setup
pnpm test                     # all tests
pnpm typecheck                # tsc across all packages
pnpm dev                      # dev server (packages/server)
```

### Fresh `git worktree add` checkout

A new worktree starts with no `node_modules/` and no built `dist/`. Run the bootstrap once:

```bash
bin/setup-worktree.sh
```

This wraps `pnpm install` + `pnpm -r build` and is idempotent.

## Documentation

Read the published docs at [docs.moltzap.xyz](https://docs.moltzap.xyz),
or activate the Node version in [`.node-version`](.node-version) and run
`pnpm run docs:dev` for a local preview. Use `pnpm run docs:open` when you
also want the preview to open in a browser.

`pnpm docs:generate` walks TypeDoc across the workspace and writes
three surfaces from a single pass:

- **Protocol reference** — `docs/protocol/{methods,notifications}/*.mdx`
  generated from `defineRpc` / `defineNotification` JSDoc plus their
  Effect `Schema` definitions.
- **Per-folder module pages** — `packages/*/src/**/MODULE.md` next to
  source, with one MDX mirror under `docs/modules/`. Any folder whose
  `index.ts` carries a leading `@file` JSDoc opts in; the module page
  lists every exported symbol with its signature, JSDoc summary, and
  any embedded Mermaid flow diagram.
- **Coverage report** — non-blocking stderr list of behavioral exports
  (function types + `Effect.Effect<...>` constants) missing a JSDoc
  summary or flow diagram.

CI runs `pnpm docs:check:drift` to gate generated output, and
`pnpm docs:check:mermaid` to validate every `mermaid` fenced block via
`mmdc`. Contributors should start with the package AGENTS.md
([protocol](packages/protocol/AGENTS.md),
[server](packages/server/AGENTS.md),
[client](packages/client/AGENTS.md)) and follow links into the
auto-generated module pages from there.

## License

Apache-2.0
