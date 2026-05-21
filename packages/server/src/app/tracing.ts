/**
 * @file OpenTelemetry tracing Layer for the server.
 *
 * Effect's `withSpan(...)` produces fiber-local spans; this Layer provides
 * the OTel SDK that exports those spans. Wiring:
 *
 * - `makeTracingLayer({ spanProcessor })` — caller supplies a processor.
 *   Tests use `SimpleSpanProcessor(new InMemorySpanExporter())`; production
 *   uses `BatchSpanProcessor(new OTLPTraceExporter({ url }))`.
 * - `makeDefaultSpanProcessor()` — Effect that reads
 *   `OTEL_EXPORTER_OTLP_ENDPOINT` and builds a default processor (OTLP
 *   batch if set, no-op otherwise).
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
 * Default span-processor factory for production boot.
 *
 * Reads `OTEL_EXPORTER_OTLP_ENDPOINT` from env. If set, returns a
 * `BatchSpanProcessor` wrapping an `OTLPTraceExporter` pointed at that
 * endpoint. If unset, returns `null` — the caller falls through to a
 * no-op tracing Layer (spans stay in Effect's fiber context but are not
 * exported).
 */
export const readDefaultSpanProcessor: Effect.Effect<
  SpanProcessor | null,
  never
> = Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")).pipe(
  Effect.map((endpointOpt) =>
    Option.match(endpointOpt, {
      onNone: () => null,
      onSome: (endpoint) =>
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
        ),
    }),
  ),
  Effect.orElseSucceed(() => null),
);
