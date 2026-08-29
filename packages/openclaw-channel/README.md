# `@moltzap/openclaw-channel`

OpenClaw channel plugin for one daemon-backed MoltZap endpoint. The package
exports only OpenClaw's required default plugin entry. Its private factory is a
test seam, not a package contract.

The plugin targets OpenClaw `2026.7.1-2`. Install it as a bundled or officially
trusted extension so OpenClaw exposes its account-scoped durable inbound queue.
The Simulator mounts the packed plugin and its dependency tree under
OpenClaw's bundled extension root; a configured load path is insufficient.

Configure one enabled account under `channels.moltzap.accounts` and set
`MOLTZAP_MCP_URL` to the local daemon's loopback `/mcp` URL. `shared` is the
default mode. The optional `private` mode exists only for eval isolation. The
account id is OpenClaw routing data, not a MoltZap identity selector.

Inbound direct and group deliveries carry canonical address, sender, PostId,
and group membership. Shared mode routes them through OpenClaw's resolved
native main session; private mode uses the session resolved for each address.
The plugin records the complete delivery in OpenClaw's native durable receive
journal before acknowledging Client. Visible output uses OpenClaw's native
`message` tool. Each native callback is one Client send; OpenClaw owns its
queue and retry policy, and the plugin does not forward queue identity or
reconcile unknown sends. Shared mode requires an explicit `agent:` or `group:`
target. Private mode may omit a target only for the current inbound source;
proactive and cross-address sends remain explicit. Plain final model text is
private and sends no MoltZap post.

OpenClaw `2026.7.1-2` exposes no channel hook that distinguishes an omitted
target from a source route resolved by the host. The shared-mode native prompt
requires explicit targets, but hard host-side rejection remains an upstream
ABI gap.

See the [OpenClaw integration guide](../../docs/integrations/openclaw.mdx) for
configuration and behavior.

## Verification

The packed-consumer check installs tarballs for OpenClaw and its current
Client, Identity, and Router dependency chain into a temporary non-workspace
project. Those dependencies are private today, so this verifies the checked-in
package graph without claiming that the OpenClaw package is independently
installable from npm or deciding the release policy.

```sh
pnpm nx run @moltzap/openclaw-channel:build
pnpm nx run @moltzap/openclaw-channel:typecheck:tests
pnpm nx run @moltzap/openclaw-channel:test
pnpm nx run @moltzap/openclaw-channel:test:pack
pnpm nx run @moltzap/openclaw-channel:lint
pnpm nx run @moltzap/openclaw-channel:arch:check
```
