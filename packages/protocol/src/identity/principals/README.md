# Principal requirements

This folder declares the `AuthenticatedAgent` RPC middleware tag and the
shared `PrincipalRequirement` type. Descriptors list the tag in `requires` to
state that a call runs as an authenticated agent.

The tag is a protocol contract, not an authentication implementation.
`@moltzap/server-core` supplies the per-connection Layer that resolves it or
raises its declared failure.
