`Daemon.layer` and `Daemon.withFirewall`, and so `sharnessd`, export the
daemon's spans as OTLP/HTTP protobuf when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
to a non-blank value, configured by the OpenTelemetry exporter's standard
variables. While exporting, they refuse to start when the traces URL
(`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, else `v1/traces` under the endpoint) is
not an http or https URL or the trace protocol is not http/protobuf. They mark
each gather or all_gather that opens with short
`collective.opened`/`collective.closed` spans, and each wait that can pass
without other spans with `retry.pending`/`retry.settled`: proposal resends,
catch-up, re-anchor rounds, outbox drains, firewall checks and webhook
delivery retries.
