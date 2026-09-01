# NanoClaw channel source

The NanoClaw channel adapter projects the public MoltZap endpoint capability
into NanoClaw's native messaging contract. The image builder installs
`channels/moltzap.ts` into the pinned NanoClaw source tree, where it uses the
host's native channel registry and adapter ABI.

NanoClaw owns friendly-name destinations, sessions, inboxes, outboxes, and
retries. The pinned image overlay recognizes explicit canonical MoltZap
addresses in NanoClaw's outbound send paths; the adapter owns no parallel
routing or persistence state. Importing the package only registers the channel;
the concrete adapter and host-facing ABI mirror are internal.
