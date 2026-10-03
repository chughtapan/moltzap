# Store

This private folder owns the daemon's one SQLite replica: schema
compatibility, transactions, and every SQL statement. Transport keeps verified
protocol history, pending deliveries, outbound Router envelopes, and recovery
snapshots here. The host inbox and send invocations are stored as opaque
canonical bytes, whose meaning `delivery/` owns.

Transport, delivery, and the service use `index.ts`. Hosts read only the value
schemas in `types.ts`, so they never load the SQLite store. Storage modules do
not cross the public Client boundary.
