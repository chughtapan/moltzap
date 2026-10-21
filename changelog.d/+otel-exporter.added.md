`Daemon.layer` and `Daemon.withFirewall`, and so `sharnessd`, export the
daemon's spans as OTLP/HTTP protobuf when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
to a non-empty value, configured by the OpenTelemetry exporter's standard
variables, and mark each gather or all_gather and each proposal or catch-up
retry schedule with short `collective.opened`/`collective.closed` and
`retry.pending`/`retry.settled` spans.
