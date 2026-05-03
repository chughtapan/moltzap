import { Cause, Data, Effect, Layer } from "effect";
import type { TracerInitOptions } from "../types.js";

type NodeSdkModule = typeof import("@effect/opentelemetry/NodeSdk");
type OtlpExporterModule =
  typeof import("@opentelemetry/exporter-trace-otlp-http");
type SdkTraceBaseModule = typeof import("@opentelemetry/sdk-trace-base");

const TRACER_DEP_LOAD_CONCURRENCY = 3;

interface TracerDeps {
  readonly NodeSdk: NodeSdkModule;
  readonly OTLPTraceExporter: OtlpExporterModule["OTLPTraceExporter"];
  readonly BatchSpanProcessor: SdkTraceBaseModule["BatchSpanProcessor"];
}

export class TracerInitError extends Data.TaggedError("TracerInitError")<{
  readonly reason:
    | "PeerDepMissing"
    | "ExporterFactoryFailed"
    | "InvalidEndpoint";
  readonly message: string;
  readonly cause?: Cause.Cause<unknown>;
}> {}

export function makeTracerLayer(
  options: TracerInitOptions,
): Layer.Layer<never, TracerInitError, never> {
  if (
    options.otlpEndpoint === undefined ||
    options.otlpEndpoint.trim().length === 0
  ) {
    return Layer.empty;
  }

  return Layer.unwrapEffect(
    Effect.gen(function* () {
      const endpoint = yield* parseEndpoint(options.otlpEndpoint);
      const deps = yield* loadTracerDeps();
      return buildNodeSdkLayer(options, endpoint, deps);
    }),
  );
}

function buildNodeSdkLayer(
  options: TracerInitOptions,
  endpoint: URL,
  deps: TracerDeps,
): Layer.Layer<never, never, never> {
  const exporter = new deps.OTLPTraceExporter({ url: endpoint.toString() });
  const processor = new deps.BatchSpanProcessor(exporter);
  return deps.NodeSdk.layer(() => ({
    spanProcessor: processor,
    shutdownTimeout: options.shutdownTimeoutMs,
    resource: {
      serviceName: options.serviceName,
      attributes: {
        "service.name": options.serviceName,
        "moltzap.app_id": options.appId,
      },
    },
  })).pipe(Layer.discard);
}

function parseEndpoint(
  raw: string | undefined,
): Effect.Effect<URL, TracerInitError> {
  return Effect.try({
    try: () => new URL(raw ?? ""),
    catch: (cause) =>
      new TracerInitError({
        reason: "InvalidEndpoint",
        message: `Invalid OTLP trace endpoint: ${raw ?? ""}`,
        cause: Cause.die(cause),
      }),
  });
}

function loadTracerDeps(): Effect.Effect<TracerDeps, TracerInitError> {
  const load = <A>(run: () => PromiseLike<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new TracerInitError({
          reason: isModuleResolutionError(cause)
            ? "PeerDepMissing"
            : "ExporterFactoryFailed",
          message: isModuleResolutionError(cause)
            ? "Optional OpenTelemetry peer dependency is missing"
            : "Failed to load OpenTelemetry tracer dependency",
          cause: Cause.die(cause),
        }),
    });

  return Effect.all(
    [
      load(() => import("@effect/opentelemetry/NodeSdk")),
      load(() => import("@opentelemetry/exporter-trace-otlp-http")),
      load(() => import("@opentelemetry/sdk-trace-base")),
    ],
    { concurrency: TRACER_DEP_LOAD_CONCURRENCY },
  ).pipe(
    Effect.map(([NodeSdk, exporter, traceBase]) => {
      return {
        NodeSdk,
        OTLPTraceExporter: exporter.OTLPTraceExporter,
        BatchSpanProcessor: traceBase.BatchSpanProcessor,
      };
    }),
  );
}

function isModuleResolutionError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const code = Object.getOwnPropertyDescriptor(cause, "code")?.value;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}
