# Delivery

This private folder owns what a host sees of the endpoint: the classified
inbox and its delivery tokens, send invocations and their retained outcomes,
the pass that classifies pending deliveries and publishes them, the history
export, and the operations hosts call on them.

`index.ts` serves the service. It exports one service's `HostDelivery`, whose
state the delivery pass and every host operation share, and the pass itself.
Hosts load only `operations.ts` and `history-export.ts`, which hold values and
decoders, never the inbox or the store.
