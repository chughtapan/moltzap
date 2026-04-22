/**
 * Architecture-only contract for shared runtime observability.
 *
 * Implementers fill this in during the approved runtime cleanup slice.
 */

import { Data, Effect } from "effect";
import type { Logger } from "../logger.js";
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
        readonly _tag: "AnnotationRejected";
        readonly field: string;
        readonly message: string;
      }
    | {
        readonly _tag: "FiberSupervisorUnavailable";
        readonly message: string;
      };
}> {}

export function createRuntimeObservability(
  _config: RuntimeProcessConfig,
): Effect.Effect<RuntimeObservability, RuntimeObservabilityError, never> {
  throw new Error("not implemented");
}

export function withRuntimeLogContext<A, E, R>(
  _context: RuntimeLogContext,
  _effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  throw new Error("not implemented");
}

export function withRuntimeTraceSpan<A, E, R>(
  _span: RuntimeTraceSpan,
  _effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  throw new Error("not implemented");
}
