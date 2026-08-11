# Channel adapters

This folder owns NanoClaw's channel boundary and the MoltZap implementation of
that boundary.

- `adapter.ts` defines the host-facing channel contract.
- `channel-registry.ts` registers channel implementations by name.
- `moltzap.ts` adapts `HarnessClient` turns and replies to that contract.
- `moltzap.test-fixture.ts` supplies shared adapter fixtures; the focused
  lifecycle suite and the broader behavior suite consume them.

Network ownership stays behind `HarnessClient`. NanoClaw channel code translates
host callbacks and presentation data but does not construct a lower-level
MoltZap transport client.
