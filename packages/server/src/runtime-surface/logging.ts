/**
 * Shared runtime observability for server boot and eval orchestration.
 */

import { Data, Effect } from "effect";
import { getLogger, type Logger } from "../logger.js";
import type { RuntimeProcessConfig } from "./config.js";

export type RuntimeRequestId = string & {
  readonly __brand: "RuntimeRequestId";
};

export type RuntimeSessionId = string & {
  readonly __brand: "RuntimeSessionId";
};

export type RuntimeAgentId = string & {
  readonly __brand: "RuntimeAgentId";
};

export type RuntimeFiberId = string & {
  readonly __brand: "RuntimeFiberId";
};

export type RuntimeSpanName = string & {
  readonly __brand: "RuntimeSpanName";
};

export interface RuntimeLogContext {
  readonly requestId?: RuntimeRequestId;
  readonly sessionId?: RuntimeSessionId;
  readonly agentId?: RuntimeAgentId;
  readonly connectionId?: string;
  readonly workflow?: "rpc" | "session" | "transport" | "eval";
}

export interface RuntimeTraceSpan {
  readonly name: RuntimeSpanName;
  readonly fiberId?: RuntimeFiberId;
  readonly parentFiberId?: RuntimeFiberId;
}

export interface RuntimeObservability {
  readonly logger: Logger;
  readonly config: RuntimeProcessConfig;
  readonly annotate: <A, E, R>(
    context: RuntimeLogContext,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly span: <A, E, R>(
    span: RuntimeTraceSpan,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class RuntimeObservabilityError extends Data.TaggedError(
  "RuntimeObservabilityError",
)<{
  readonly cause:
    | {
        readonly _tag: "LoggerBootstrapFailed";
        readonly message: string;
      }
    | {
        readonly _tag: "FiberSupervisorUnavailable";
        readonly message: string;
      };
}> {}

type LogFieldValue = string | number | boolean;

function toLogAnnotations(
  context: RuntimeLogContext,
): Record<string, LogFieldValue> {
  const annotations: Record<string, LogFieldValue> = {};
  if (context.requestId !== undefined) {
    annotations["requestId"] = context.requestId;
  }
  if (context.sessionId !== undefined) {
    annotations["sessionId"] = context.sessionId;
  }
  if (context.agentId !== undefined) {
    annotations["agentId"] = context.agentId;
  }
  if (context.connectionId !== undefined) {
    annotations["connectionId"] = context.connectionId;
  }
  if (context.workflow !== undefined) {
    annotations["workflow"] = context.workflow;
  }
  return annotations;
}

function toSpanAttributes(
  span: RuntimeTraceSpan,
): Record<string, LogFieldValue> {
  const attributes: Record<string, LogFieldValue> = {};
  if (span.fiberId !== undefined) {
    attributes["runtime.fiberId"] = span.fiberId;
  }
  if (span.parentFiberId !== undefined) {
    attributes["runtime.parentFiberId"] = span.parentFiberId;
  }
  return attributes;
}

function filterContextForConfig(
  config: RuntimeProcessConfig,
  context: RuntimeLogContext,
): RuntimeLogContext {
  if (config.tracing.includeRequestContext) {
    return context;
  }
  return {};
}

function filterSpanForConfig(
  config: RuntimeProcessConfig,
  span: RuntimeTraceSpan,
): RuntimeTraceSpan {
  if (config.tracing.includeFiberIds) {
    return span;
  }
  return {
    name: span.name,
  };
}

export function createRuntimeObservability(
  config: RuntimeProcessConfig,
): Effect.Effect<RuntimeObservability, RuntimeObservabilityError, never> {
  return Effect.try({
    try: () => {
      const rootLogger = getLogger();
      rootLogger.level = config.logging.level;
      const logger = rootLogger.child({
        service: config.tracing.serviceName,
        environment: config.environment,
      });
      return {
        logger,
        config,
        annotate: <A, E, R>(
          context: RuntimeLogContext,
          effect: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E, R> =>
          withRuntimeLogContext(filterContextForConfig(config, context), effect),
        span: <A, E, R>(
          span: RuntimeTraceSpan,
          effect: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E, R> =>
          withRuntimeTraceSpan(filterSpanForConfig(config, span), effect),
      };
    },
    catch: (cause) =>
      new RuntimeObservabilityError({
        cause: {
          _tag: "LoggerBootstrapFailed",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }),
  });
}

export function withRuntimeLogContext<A, E, R>(
  context: RuntimeLogContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const annotations = toLogAnnotations(context);
  if (Object.keys(annotations).length === 0) {
    return effect;
  }
  return effect.pipe(Effect.annotateLogs(annotations));
}

export function withRuntimeTraceSpan<A, E, R>(
  span: RuntimeTraceSpan,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const attributes = toSpanAttributes(span);
  return effect.pipe(
    Effect.withSpan(span.name, {
      captureStackTrace: false,
      attributes,
    }),
  );
}
