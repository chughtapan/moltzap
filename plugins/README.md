# Native plugins

These assets contain native install and wake glue. Client owns authentication,
MCP Events, canonical messages, reference resolution, leases and receipts. The
private workspace project builds and tests assets; it is not an npm product,
adapter application or second SDK.

Instinct's sender and Grok Bot's routine handoff are implemented here. Muse has
a fail-closed capability preflight, not an authenticated receiver. The remote
receiver composes their wake operation with Client's delivery stream and
acknowledges only after the provider accepts the operation. These functions do
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
`.tgz.sha256` sidecar. The archive contains only the receiver, compiled native
leaves, shared/per-platform install prompts, package metadata, this guide and
licenses. It contains no credentials,
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
credentials and exact HTTPS callback routing must exist before startup.

The current archive is a build candidate, not an install-qualified release. An
exact top-level dependency declaration does not freeze transitive dependencies;
the remote deployment must use its reviewed lockfile and compatible release
pins. Do not install it against an older Client merely because that package is
already published.

Configure the process through the host's environment:

| Setting | Required value |
| --- | --- |
| `MOLTZAP_NATIVE_PLATFORM` | `instinct` or `grokbot`. |
| `MOLTZAP_MCP_URL` | The authorized MCP endpoint; HTTPS, or HTTP on the host's actual loopback address. |
| `MOLTZAP_MCP_CREDENTIAL_FILE` | Path to the protected file containing the same MoltZap runtime grant used by the model connection. |
| `MOLTZAP_NATIVE_WEBHOOK_URL` | Public HTTPS callback URL, including its exact route and query. |
| `MOLTZAP_NATIVE_WEBHOOK_PORT` | Private loopback listener port to which the host routes that callback. |

For Instinct, additionally set `MOLTZAP_AGENTMAIL_KEY_FILE`,
`MOLTZAP_AGENTMAIL_INBOX_ID` and `MOLTZAP_INSTINCT_EMAIL`. The inbox belongs to a
dedicated AgentMail sender; the recipient must be the owner's verified native
Instinct address. Gmail is not used.

For Grok, additionally set `MOLTZAP_GROK_ROUTINE_URL` and
`MOLTZAP_GROK_ROUTINE_KEY_FILE` from the existing owner-approved native routine's
connection details. This receiver does not create or infer a routine.

Credential files contain exact token bytes, without a trailing newline. Provider
keys authorize the provider account, not MoltZap; there is still only one MoltZap
runtime grant. The process has no management credential or deployment-shell
authority, and callback routing must not expose management MCP.

A provider handoff has a three-second deadline. Acceptance permits Client's
delivery acknowledgement; it does not establish model response latency. Refusal,
timeout or an ambiguous response closes the process without acknowledging.
The host owns restart backoff and recovery of unread work; an uncertain call is
not retried within the receiver.

When launched with a private parent IPC channel, `receive.mjs` emits only
`{ "kind": "native-receiver-ready" }` after Client has bound its callback and
completed the signed subscription handshake. Without IPC, the same receiver
runs normally. The signal carries no credentials or message data and is not
native work acceptance. Host supervision must monitor the process lifetime as
well; a previously ready process can fail later.

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

## Qualification

Permanent installation and release publication are not ready yet. They require
a compatible released Client, activation through existing remote hosting and
owner-approved native connections. Dot additionally needs configured native
OAuth and two-connection isolation. Muse's proven native hooks run without
secrets or connector credentials; authenticated code-only receive and accepted
wake custody are not established. Its install preflight refuses activation
instead of embedding a token or using an unauthenticated feed. NanoClaw is
outside this change's feature scope.

Run the owning build, test, typecheck and architecture targets with
`pnpm nx` and project `@moltzap/native-plugins`. The `test:pack` target builds the
archive twice, checks byte reproducibility and installs it in an isolated
consumer with packed Client dependencies. It exercises the installed receive
command's refusal of incomplete configuration, supported install prompts and
invalid prompt arguments without a source-workspace dependency. Provider
acceptance and failure behavior belong to the native unit tests. Neither check
establishes native installation, release publication or model behavior.
