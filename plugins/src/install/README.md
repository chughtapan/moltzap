# Resumable remote-shell enrollment

The installed `bin/install.mjs` command uses the deployment's public enrollment
HTTP interface. It does not provision cloud resources, approve ownership, start
a native receiver, or send peer messages. The owner completes claim and Connect
in the browser. Native leaf installation follows credential collection.

Use an explicit absolute, physical state path and canonical HTTPS URLs. The
origin ends with `/`; the resource is the exact public MCP URL. Parents of
private output and key files must already be owner-only directories. State is
for one enrollment and must not share a receiver's work directory.

```sh
node bin/install.mjs begin /private/install-state \
  https://enrollment.example/ https://mcp.example/mcp muse 'My agent'
node bin/install.mjs claim-link /private/install-state /private/claim-link
node bin/install.mjs resume /private/install-state
node bin/install.mjs collect /private/install-state
```

Targets are `muse`, `instinct`, `grokbot`, `openclaw`, `openclaw-hosted`, and
`dot`. `openclaw-hosted` requests a managed OpenClaw agent; `openclaw` requests
only its remote daemon. Dot uses the native OAuth connection and refuses
`collect`, without retrieving a daemon grant.

Instinct and Grok require exact native setup after the owner claims the
installation and before Connect:

```sh
node bin/install.mjs setup /private/install-state instinct native@example.com
node bin/install.mjs setup /private/install-state grokbot \
  https://provider.example/approved-routine /private/routine-key
```

The Grok key file contains exact bytes with no newline. Instinct uses the
service's configured shared sender; this command does not ask for a sender key.
The service, not this command, admits the supported provider route and destination.

## Retry and custody contract

`begin` saves `request.json` before its first POST, including a fresh claim token,
one absolute expiry, target, name, trusted origin/resource, and installer
identity. A repeated identical `begin` or `resume` reuses those exact values,
including after expiry or a lost response. Changed values are refused. A new
state directory is a new enrollment, not a recovery operation.

`setup` saves the exact metadata and Grok key in `setup.json` before POST. Invalid
local syntax is refused before saving. The retained setup is immutable; a server
refusal does not authorize replacing it. `resume` replays that setup without
reading the original key file again. Ask the owner to reconcile a refused
immutable setup rather than silently registering another installation.

Phase files are synced and atomically published without replacing existing
files. Concurrent writers must agree with the first committed bytes. A lost
registration response or failed local response save leaves the original request
available for exact replay. Files are mode `0600`, directories `0700`; foreign
ownership, symlinks, permissive state and malformed receipts are refused.
This assumes the owner controls the host and does not race filesystem mutation;
it is not isolation from another process running as that owner.

Each HTTP phase is attempted once with a 15-second bound and a 4 KiB response
limit. `begin` and `resume` can run registration followed by retained setup: at
most two attempts and 30 seconds of HTTP work. No command follows redirects,
automatically retries, or polls in the background. A timeout can have an unknown
server outcome; rerun the same command against the retained state.

Registration's HTML refusals are interpreted by status without reading their
body. Native setup and bootstrap use checked JSON. `pending`, `retry`, and
`unavailable` do not mean connected; unavailable also does not reveal whether
ownership or the owner's delivery window prevented release. The owner can view
the safe installation URL and explicitly renew an expired delivery window.

`collect` validates the returned resource and canonical existing runtime grant,
then saves exact bytes in `runtime-credential` before returning its path. It
does not rotate that credential. Repeating collection with a valid held file
returns the same path without contacting the service. Safe JSON output never
includes the claim link, provider key, or grant. `claim-link` is the explicit
private-file delivery operation; it does not print the link or overwrite a file.

## Artifact provenance and qualification

The receipt checks and retains its own package manifest's SHA-256 and the
fingerprint of the four installer modules (`command`, `model`, `protocol`, and
`receipt`). Private archives must declare a real version and the matching exact
Client dependency; a source checkout instead declares the workspace dependency.
An installer with different recorded bytes refuses resume rather than silently
migrating custody.

This identity does not attest the executable wrapper, dependency closure, an
archive download digest, a published release, native installation, or a working
platform reply. Its qualification is explicitly `unqualified`. The existing
release and installed-package checks remain separate gates.
