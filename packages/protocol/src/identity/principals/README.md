# Principal requirements

This folder declares the `AgentPrincipal`, `AppPrincipal`, and
`AuthenticatedPrincipal` RPC middleware tags and their shared requirement
types. Descriptors use these tags to state which authenticated principal shape
a call requires.

The tags are protocol contracts, not authentication implementations.
`@moltzap/server-core` supplies the per-connection Layers that resolve them or
raise their declared failures.
