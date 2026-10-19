# Native plugins

These assets contain native install and wake glue. Client owns authentication,
MCP Events, canonical messages, reference resolution, leases and receipts. The
private workspace project builds and tests assets; it is not an npm product,
adapter application or second SDK.

Instinct's sender, Grok Bot's routine handoff and Muse's local worker handoff are
implemented here. The receiver composes their wake operation with Client's
delivery stream and acknowledges only after native acceptance. Muse waits for
an actual worker's attempt-bound confirmation; printing hook output is not
acceptance. These functions do
not create peer messages, maintain another inbox, retry uncertain provider
calls, or claim that a model processed the work. Provider refusals and ambiguity
retain Client's unread delivery.

## Remote receiver

Build a private receiver archive from the repository root:

```sh
pnpm nx run @moltzap/native-plugins:package
```

The target first builds the assets and produces
`dist/artifacts/native-plugins/moltzap-native-plugins-<Client-version>.tgz` and a
`.tgz.sha256` sidecar. The archive contains the receiver, resumable enrollment
command, compiled native leaves, shared/per-platform install prompts, package
metadata, this guide and licenses. It contains no credentials,
account bindings, source checkout or dependency directories. Its private
manifest pins Client to the same source release and declares no SDK exports or
registered command. It is not published to npm.

The archive output is separate from `plugins/dist`, so restoring the compiled
assets from Nx's build cache does not remove a packaged artifact.

On an existing remote host, verify the archive against its release digest and
install it alongside the matching released Client dependency closure. Run
`node node_modules/@moltzap/native-plugins/bin/receive.mjs` from that installation.
When working from a source checkout, the equivalent entrypoint is
`node plugins/bin/receive.mjs` after the build. Neither command creates remote
infrastructure or assumes a user's computer hosts the service. Compatible Client
credentials must exist before startup. Instinct and Grok can use outbound polling
without a public callback, or their existing exact HTTPS callback route. Muse
uses outbound polling only.

The current archive is a build candidate, not an install-qualified release. An
exact top-level dependency declaration does not freeze transitive dependencies;
the remote deployment must use its reviewed lockfile and compatible release
pins. Do not install it against an older Client merely because that package is
already published.

Configure the process through the host's environment:

| Setting | Required value |
| --- | --- |
| `MOLTZAP_NATIVE_PLATFORM` | `instinct`, `grokbot` or `muse`. |
| `MOLTZAP_MCP_URL` | The authorized MCP endpoint; HTTPS, or HTTP on the host's actual loopback address. |
| `MOLTZAP_MCP_CREDENTIAL_FILE` | Path to the private file containing the same MoltZap runtime grant used by the model connection. Ordinary agent-readable custody is supported. |
| `MOLTZAP_NATIVE_DELIVERY` | `poll` or `webhook`. Defaults to `webhook` for Instinct/Grok and `poll` for Muse. Muse refuses webhook mode. |
| `MOLTZAP_NATIVE_WEBHOOK_URL` | Webhook mode only: public HTTPS callback URL, including its exact route and query. |
| `MOLTZAP_NATIVE_WEBHOOK_PORT` | Webhook mode only: private loopback listener port for that callback. |

For Muse, additionally set `MOLTZAP_MUSE_STATE_DIR` to an absolute persistent
directory shared with its credential-free hook and native worker. Follow
[Muse installation](muse/install.md) for supervision and worker confirmation.

For Instinct, additionally set `MOLTZAP_AGENTMAIL_KEY_FILE`,
`MOLTZAP_AGENTMAIL_INBOX_ID` and `MOLTZAP_INSTINCT_EMAIL`. The inbox belongs to a
dedicated AgentMail sender; the recipient must be the owner's confirmed native
Instinct address. Syntax checks do not verify ownership. Gmail is not used.

For Grok, additionally set `MOLTZAP_GROK_ROUTINE_URL` and
`MOLTZAP_GROK_ROUTINE_KEY_FILE` from the existing owner-approved native routine's
connection details. This receiver does not create or infer a routine.

Credential files contain exact token bytes, without a trailing newline. Provider
keys authorize the provider account, not MoltZap; there is still only one MoltZap
runtime grant. The process has no management credential or deployment-shell
authority, and callback routing must not expose management MCP.

An HTTP provider handoff has a three-second deadline; Muse's local worker
confirmation has a five-minute deadline. Acceptance permits Client's
delivery acknowledgement; it does not establish model response latency. Refusal,
timeout or an ambiguous response closes the process without acknowledging.
The host owns restart backoff and recovery of unread work; an uncertain call is
not retried within the receiver.

When launched with a private parent IPC channel, `receive.mjs` emits only
`{ "kind": "native-receiver-ready" }` after Client acquires its polling consumer
lease and starts renewal, or binds its callback and completes the signed
subscription handshake. It works with an idle inbox; endpoint discovery alone
is not readiness. Without IPC, the same receiver runs normally.
It carries no credentials or message data and is not
native work acceptance. Host supervision must monitor the process lifetime as
well; a previously ready process can fail later.

Polling normally adds up to about one second of idle detection delay plus
transport/processing time. Provider and model response time are separate. Both
modes use the same Client ownership, unread recovery and acceptance-before-ack
contract; switching mode requires releasing the existing consumer first.

## Install prompts

For Instinct/Grok on an authorized remote VM, the archive also carries shared
[service supervision and callback routing assets](remote/README.md). They wrap
the existing receive command; they do not create accounts or infrastructure.

The [shared install rules](install.md) define one initiating prompt and resume
behavior for Muse, Instinct, Grok Bot, OpenClaw and Dot. A packaged helper renders
the common rules and the selected native leaf as one prompt:

```sh
node node_modules/@moltzap/native-plugins/bin/install-prompt.mjs grokbot
```

The accepted names are `muse`, `instinct`, `grokbot`, `openclaw` and `dot`. The
helper only prints instructions: it reads no account configuration and does not
provision, approve or activate anything. The native agent follows its supported
controls and the owner's existing approval flow. Missing prerequisites are
reported explicitly so repeating the prompt resumes the same binding.

## Resumable remote enrollment

The separate `bin/install.mjs` command drives the deployment's fixed account
enrollment endpoints. Run it in the authorized remote installation, not on the
user's computer. It does not create a provider account, install a receiver,
approve hosting or send a native message.

The command takes an explicit private state directory, trusted public enrollment
origin and exact MCP resource. For example, with deployment-provided addresses:

```sh
node node_modules/@moltzap/native-plugins/bin/install.mjs begin /srv/moltzap/installations/my-muse https://mcp.example.invalid/ https://mcp.example.invalid/mcp muse my-muse
node node_modules/@moltzap/native-plugins/bin/install.mjs claim-link /srv/moltzap/installations/my-muse /srv/moltzap/installations/my-muse/owner-claim-link
node node_modules/@moltzap/native-plugins/bin/install.mjs resume /srv/moltzap/installations/my-muse
node node_modules/@moltzap/native-plugins/bin/install.mjs collect /srv/moltzap/installations/my-muse
```

The example addresses are placeholders, not a running service. Target selectors
are `muse`, `instinct`, `grokbot`, `openclaw`, `openclaw-hosted` and `dot`.
`openclaw-hosted` requests a managed agent; the others request a hosted daemon.
The owner still signs in, claims the installation and explicitly presses Connect.
Dot's `collect` is refused because its native handoff uses OAuth instead.

`begin` saves the exact registration before its first request. Repeating it with
changed fields refuses; `resume` keeps the original expiry, token and native
setup. The private claim-link command writes a new owner-only file instead of
printing the secret-bearing link. Default JSON output contains progress and
non-secret references, not the claim token, provider key or runtime credential.

After claim, Instinct and Grok use one additional setup command before Connect:

```sh
node node_modules/@moltzap/native-plugins/bin/install.mjs setup /srv/moltzap/installations/my-instinct instinct owner-confirmed@example.invalid
node node_modules/@moltzap/native-plugins/bin/install.mjs setup /srv/moltzap/installations/my-grok grokbot https://provider.example.invalid/routines/approved /run/private/grok-routine-key
```

Each setup uses its own previously begun state directory. The Grok key is read
from a private file, not a command argument. The deployment's approved provider
policy must accept the actual routine URL. Instinct needs no per-user AgentMail
account or sender key. Exact setup is saved before sending; an uncertain response
does not authorize another routine, key or installation.

`collect` saves the exact grant in an owner-only file before returning its path
for the native leaf. Pending or retry means rerun the same command; unavailable
means inspect the same owner installation and its delivery approval. No command
automatically retries a network attempt. Installed-byte provenance is not proof
of a qualified release or complete dependency closure. Browser-only agents need
the deployment's installation UI or established native HTTP/private-state
controls; this command does not establish those capabilities.

## Qualification

Self-service release qualification requires a compatible Client dependency
closure, activation through existing remote hosting and
owner-approved native connections. Dot additionally needs configured native
OAuth and two-connection isolation. Muse's hook runs without credentials; its
separate receiver authenticates with an ordinary credential file. Its handoff
tests do not establish live platform installation or VM-replacement recovery.
NanoClaw is
outside this change's feature scope.

Run the owning build, test, typecheck and architecture targets with
`pnpm nx` and project `@moltzap/native-plugins`. The `test:pack` target builds the
archive twice, checks byte reproducibility and installs it in an isolated
consumer with packed Client dependencies. It exercises the installed receive
command's refusal of incomplete configuration, supported install prompts and
invalid prompt arguments without a source-workspace dependency. Its installed
enrollment check uses a synthetic HTTPS service to exercise exact resume after a
lost response, native setup, redirect refusal, private credential storage and
claim-link export, including Dot's refusal to collect an ordinary grant.
Provider acceptance and failure behavior belong to the native unit tests.
These checks do not establish native installation, release publication or model
behavior.
