# Event wire contract

This private facade owns item occurrences, native polling results and consumer
generation metadata. Native hosts and the daemon use the same derived types,
decoders and JSON Schema documents. Schema constructors remain private.

It loads no server SDK, store, signing authority or network service. The daemon's
`mcp/events` folder turns retained rows into occurrences and owns delivery;
`harness-endpoint` owns the native connection and scoped receive lifecycle.
