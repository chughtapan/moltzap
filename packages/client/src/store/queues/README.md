# Store queues

The two durable queues in the endpoint's SQLite replica. `deliveries.ts`
holds certified posts waiting for the host to accept them. `outbound.ts` holds
signed Router envelopes until the Router accepts them.

`index.ts` is the only entrypoint. The store assembly in `../store.ts`, the
recovery reads in `../reads.ts` and record promotion in `../records.ts` reach
the queues through it.
