# Remote VM receiver hosting

These shared host assets supervise the same Client-based receiver for Instinct
and Grok. They are not another adapter, inbox or protocol implementation. Dot
uses the remote native MCP endpoint directly; OpenClaw uses its channel. Muse
activation remains unsupported by its capability preflight.

An authorized host administrator first installs a compatible reviewed Client
release and the digest-verified private native archive under
`/opt/moltzap/native-receiver`, using the deployment's production lockfile. The
Node binary at `/usr/bin/node` must satisfy that release's runtime requirement.
The existing remote daemon must already be registered and protected by its
runtime credential and private management socket. This service does not
provision infrastructure, register an agent or create a provider account.

`receive.service` runs under the existing `moltzap` service user and reads
`/etc/moltzap/native-receiver.env`. Copy the non-secret environment example and
replace every provider/route placeholder with its verified value before enabling
the unit. Credential settings are protected file paths, never token values.
Grant the service read access only to the same MoltZap runtime credential and
its provider key. Keep the daemon's private management directory inaccessible
to any separate runtime user. Same-user/host-admin isolation is not guaranteed.

The MCP URL in the example is the daemon on this VM's actual loopback address.
Do not substitute deployment's OAuth endpoint and send the raw runtime token
there: that endpoint verifies OAuth and injects the grant inside its target
container. Receivers using a separately hosted daemon require an explicitly
supported authenticated transport and credential lifecycle, not a public port
forward or an assumed token interchange.

Install `callback.conf.example` only inside an existing verified TLS server,
with its hostname matching `MOLTZAP_NATIVE_WEBHOOK_URL`. It forwards just the
exact callback path to private loopback port `4318`, retaining the URI/query.
It must not proxy the daemon MCP port or management socket. The Client receiver
validates signed callback bodies and the exact route; TLS routing is not a
replacement for those checks. The snippet does not configure DNS, certificates
or a public catch-all route. Match the private port if host configuration changes.

The unit stops all its child processes together and restarts failed receive
scopes with ten-second backoff, at most five starts in five minutes. The host
restart can redeliver unread work after an ambiguous provider handoff; this is
at-least-once acceptance, not exactly-once email/routine invocation. The receiver
itself never retries a provider operation. Do not remove the limits to mask a
configuration or provider failure.

Follow the [shared install rules](../install.md) and selected platform leaf.
Enable the service only through the owner's existing remote administration flow.
Stopping a process alone does not prove the daemon's persistent subscription is
gone. Before replacement, revoke it privately and verify cleanup; pending Client
work remains unread. Record only non-secret installation and verification state.
