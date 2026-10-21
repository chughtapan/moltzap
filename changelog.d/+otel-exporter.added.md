`Daemon.layer`, and so `sharnessd`, exports the daemon's spans as OTLP/HTTP
protobuf when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, under the standard `OTEL_*`
configuration, and marks each gather or all_gather and each proposal or
catch-up retry schedule with short `collective.opened`/`collective.closed` and
`retry.pending`/`retry.settled` spans.
