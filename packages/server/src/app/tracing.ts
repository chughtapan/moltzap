/**
 * @file OpenTelemetry tracing Layer for the server.
 *
 * Effect's `withSpan(...)` produces fiber-local spans; this Layer provides
 * the OTel SDK that exports those spans. Wiring:
 *
 * - `makeTracingLayer({ spanProcessor })` — caller supplies a processor.
 *   Tests use `SimpleSpanProcessor(new InMemorySpanExporter())`; production
 *   uses `BatchSpanProcessor(new OTLPTraceExporter({ url }))`.
 * - `readDefaultSpanProcessor` — Effect that reads the OTLP endpoint env
 *   vars and builds a default processor (OTLP batch if set, no-op
 *   otherwise). Honors the trace-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
 *   (used as-is) ahead of the base `OTEL_EXPORTER_OTLP_ENDPOINT` (suffixed
 *   with `/v1/traces`), per the OTel exporter env-var spec.
 *
 * `app/server.ts` consumes this; tests inject their own InMemorySpanExporter
 * via `CoreConfig.spanProcessor` and read finished spans back from it.
 */

import { NodeSdk } from "@effect/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Config, Effect, type Layer, Option } from "effect";

const SERVICE_NAME = "moltzap-server";
const SLASH_CHAR_CODE = "/".charCodeAt(0);

interface TracingLayerInput {
  readonly spanProcessor: SpanProcessor;
  readonly serviceVersion?: string;
}

/**
 * Build a tracing Layer that wires the OTel SDK with the given span
 * processor. The processor controls how spans get exported (OTLP batch
 * in production; in-memory simple processor in tests).
 */
export function makeTracingLayer(input: TracingLayerInput): Layer.Layer<never> {
  return NodeSdk.layer(() => ({
    resource: {
      serviceName: SERVICE_NAME,
      ...(input.serviceVersion === undefined
        ? {}
        : { serviceVersion: input.serviceVersion }),
    },
    spanProcessor: input.spanProcessor,
  }));
}

/**
 * Resolve the traces OTLP URL from the standard OTel env vars. The
 * trace-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is the full traces URL
 * and is used verbatim; the base `OTEL_EXPORTER_OTLP_ENDPOINT` is a signal
 * root that gets `/v1/traces` appended. Returns `null` when neither is set.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) end -= 1;
  return value.slice(0, end);
}

export function resolveTracesEndpoint(
  tracesEndpoint: string | undefined,
  baseEndpoint: string | undefined,
): string | null {
  if (tracesEndpoint !== undefined) return tracesEndpoint;
  if (baseEndpoint === undefined) return null;
  // Normalize the join so a trailing slash on the base endpoint does not
  // produce `//v1/traces`. Linear scan, not a regex (avoids backtracking).
  return `${stripTrailingSlashes(baseEndpoint)}/v1/traces`;
}

/**
 * Default span-processor factory for production boot.
 *
 * Reads the OTLP endpoint env vars. If either is set, returns a
 * `BatchSpanProcessor` wrapping an `OTLPTraceExporter` pointed at the resolved
 * traces URL. The trace-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` takes
 * precedence over the base `OTEL_EXPORTER_OTLP_ENDPOINT`. If neither is set,
 * returns `null` — the caller falls through to a no-op tracing Layer (spans
 * stay in Effect's fiber context but are not exported).
 */
export const readDefaultSpanProcessor: Effect.Effect<
  SpanProcessor | null,
  never
> = Effect.all({
  tracesEndpoint: Config.option(
    Config.string("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
  ),
  baseEndpoint: Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")),
}).pipe(
  Effect.map(({ tracesEndpoint, baseEndpoint }) => {
    const url = resolveTracesEndpoint(
      Option.getOrUndefined(tracesEndpoint),
      Option.getOrUndefined(baseEndpoint),
    );
    return url === null
      ? null
      : new BatchSpanProcessor(new OTLPTraceExporter({ url }));
  }),
  Effect.orElseSucceed(() => null),
);
