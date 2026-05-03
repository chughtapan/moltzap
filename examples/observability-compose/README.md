# Observability Compose

Local Jaeger for testing app-sdk tracing.

```bash
docker compose -f examples/observability-compose/compose.yml up
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

Then start an app with:

```typescript
const app = new MoltZapApp({
  serverUrl: "ws://localhost:41973",
  agentKey: process.env.MOLTZAP_AGENT_KEY,
  appId: "observed-app",
  observability: {
    tracing: { enabled: true },
    replay: { enabled: true },
  },
});
```

Jaeger UI: <http://localhost:16686>
