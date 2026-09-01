# Endpoint store internals

This private folder owns the daemon's one SQLite replica, including schema
compatibility, verified protocol history, pending host delivery, outbound
Router envelopes, and recovery snapshots.

Endpoint code uses the private `../store.ts` facade. Storage modules do not
cross the public Client boundary.
