`Daemon.layer` and `Daemon.withFirewall`, and so `sharnessd`, export the
daemon's spans as OTLP/HTTP protobuf when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
to a non-blank value, configured by the OpenTelemetry exporter's standard
variables, and refuse to start when that endpoint is not an http or https URL
or the trace protocol is not http/protobuf. They mark each gather or
all_gather and each proposal or catch-up retry schedule with short
`collective.opened`/`collective.closed` and `retry.pending`/`retry.settled`
spans.
