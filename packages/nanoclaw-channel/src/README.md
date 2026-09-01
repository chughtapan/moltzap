# NanoClaw channel source

The NanoClaw channel adapter projects the public MoltZap endpoint capability
into NanoClaw's native messaging contract. The image builder installs
`channels/moltzap.ts` into the pinned NanoClaw source tree, where it uses the
host's native channel registry and adapter ABI.

NanoClaw owns destination ACLs, groups, sessions, inboxes, and outboxes. The
adapter owns no parallel routing or persistence state. Only the package root is
exported; the host-facing ABI mirror is internal.
