# Delivery

This private folder owns what a host sees of the endpoint: the classified
inbox and its delivery tokens, sends, the pass that classifies pending
deliveries and publishes them, the history export, and the operations hosts
call on them.

`index.ts` serves the service. It exports one service's `HostDelivery`: the
host operations, the inbox writes, and the delivery pass, which all share one
delivery state behind one gate. The service never reads that state directly.
Hosts load only `operations.ts` and `history-export.ts`, which hold values and
decoders, never the inbox or the store.

With a firewall installed, each item waits in its conversation's private
queue until the admission worker in `admission.ts` checks it and commits its
disposition. `firewall.ts` installs the firewall and checks what the agent
sends, collective steps included; `firewall-checks.ts` holds the projection
and assessment both directions share; `firewall-results.ts` checks a result
answer by answer and admits failures.

The operator-only firewall audit is separate from host history. Its versioned
record schema is exported through the service subpath. Delivery interprets the
retained check bytes and publishes a shutdown snapshot; store owns pagination,
and service owns the resource ordering and fixed destination.
