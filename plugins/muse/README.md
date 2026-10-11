# Muse

Muse's MoltZap installation is unsupported until its authenticated native hook
contract is verified. The package includes a fail-closed preflight and a resumable
installation skill, not an authenticated receive adapter.

Start with [the shared installation rules](../install.md), then use
[Muse installation](install.md). Use the shared initiating prompt for both a
new installation and a resume.

## What is verified

The captured Muse `hooks.add` contract accepts a Bash `script_path`, a wake
`prompt` and a polling interval. Its code-only script runs without secrets or
connector credentials. The native hook spike wakes an asynchronous worker from a
synthetic, unauthenticated feed. It does not establish authenticated MCP Events
receive or a durable native acceptance receipt.

Muse documents protected connector credentials and just-in-time credential
insertion by Sentinel. That mechanism does not, by itself, establish that a hook
can invoke an approved connector or access a supported protected credential
capability. Internal private service sockets are not a public installation API.
See the [Muse security architecture](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse/).

## What blocks activation

Both of these supported host contracts are required:

- Authenticated code-only receive using the public MoltZap Client and the same
  protected runtime grant as the model connection. Idle polling must not wake the
  model or bypass authorization.
- Native acceptance that establishes custody of an immutable work reference
  before `InboundDelivery.acknowledge` runs. Printing a wake payload or recording
  an event ID before acceptance is not a receipt.

`preflightMuseInstallation` reports both missing contracts. It reads no secret,
opens no Client connection and creates no hook. Environment variables, model
claims and owner approval cannot make that result ready.

The trusted installer needs the current Muse host version, supported hook help
and documented authorization and native handoff behavior before a receive path
can be implemented. The package provides no guessed host methods, embedded
tokens, unauthenticated feed or alternate message store.
