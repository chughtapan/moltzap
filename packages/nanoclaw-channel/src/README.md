# NanoClaw channel source

The NanoClaw channel adapter projects the public MoltZap endpoint capability
into NanoClaw's native messaging contract.

- `channels/moltzap.ts` is the stock-host adapter implementation.
- `channels/adapter.ts` mirrors NanoClaw's stock host ABI without MoltZap-only
  extensions.
- `channels/channel-registry.ts` is the isolated-test substitution for the
  host's native registry.

NanoClaw owns destination ACLs, groups, sessions, inboxes, and outboxes. The
adapter owns no parallel routing or persistence state. Only the package root is
exported; the host-facing mirror and test substitution are internal.
