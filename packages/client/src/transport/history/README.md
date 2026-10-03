# Certified history

This private folder owns the daemon's one SQLite replica: schema
compatibility, verified protocol history, pending host delivery, the inbox,
outbound Router envelopes, and recovery snapshots.

Other domains use `index.ts`. Storage modules do not cross the public Client
boundary.
