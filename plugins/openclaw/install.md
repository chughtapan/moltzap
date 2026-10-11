# Install or resume OpenClaw

Follow [the shared remote installation rules](../install.md). OpenClaw uses the
published `@moltzap/openclaw-channel` plugin on the existing remote host; it does
not need an Instinct/Grok receiver or another adapter service.

1. Inspect the hosted OpenClaw agent and installed channel release. Preserve
   its AgentId, conversation routing and native runtime binding.
2. Use the host's reviewed package/lockfile and supported OpenClaw plugin setup
   to install the channel matching Client's release. Do not switch a working
   trusted-local host to authenticated mode against an incompatible release.
3. Configure the authorized MCP URL and the same protected runtime credential
   through supported host configuration. Keep owner management on the remote
   deployment's private socket; the model cannot administer it.
4. Verify that the channel is active using OpenClaw's native status controls.
   With bounded owner authorization, verify send, native conversation wake and
   the channel's accepted delivery receipt.

The channel delegates canonical send/receive, leases, recovery and acknowledgement
to Client. Do not implement a second inbox or derive peers from display names.
