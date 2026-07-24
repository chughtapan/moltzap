/**
 * @file Branded runtime identifiers and closed literal vocabularies
 * shared across the simulator modules. Config-time identifiers (Seed,
 * SpecHash, slot names) live in `run-spec.ts`; these are the identities
 * minted while a run executes plus the literal vocabularies that recur
 * in events, errors, and provenance. None is ever allocated from
 * construction order.
 */
import { Schema, type Brand } from "effect";

/** Closed union of registered runtime kinds; provenance, events, and errors reuse it. */
export const RuntimeKind = Schema.Literal(
  "openclaw",
  "nanoclaw",
  "stub",
).annotations({ description: "Registered runtime kind" });
export type RuntimeKind = typeof RuntimeKind.Type;

/** Closed fault-kind vocabulary; events and errors reuse it instead of plain strings. */
export const FaultKind = Schema.Literal(
  "sever",
  "delay",
  "throttle",
).annotations({
  description: "Connection-level fault kind",
});
export type FaultKind = typeof FaultKind.Type;

export type RunId = string & Brand.Brand<"RunId">;
/** Unique per attempt execution: `{specHash12}-s{seed}-a{attempt}`. */
export const RunId: Schema.Schema<RunId, string> = Schema.NonEmptyString.pipe(
  Schema.brand("RunId"),
  Schema.annotations({ description: "Run identity stamped on every event" }),
);

export type AttemptId = string & Brand.Brand<"AttemptId">;
/** Unique attempt under one recording identity; format `a{n}`, store-allocated. Path-safe by construction. */
export const AttemptId: Schema.Schema<AttemptId, string> = Schema.String.pipe(
  Schema.pattern(/^a\d+$/),
  Schema.brand("AttemptId"),
  Schema.annotations({
    description:
      "Attempt identity under a (specHash, seed) recording identity; a<n>",
  }),
);

export type EpisodeId = string & Brand.Brand<"EpisodeId">;
/** Episode identity; v0 runs exactly one episode per run but the shape stays multi-episode-representable. */
export const EpisodeId: Schema.Schema<EpisodeId, string> =
  Schema.NonEmptyString.pipe(
    Schema.brand("EpisodeId"),
    Schema.annotations({
      description: "Episode identity on episode-scoped events",
    }),
  );

export type LogicalSequence = number & Brand.Brand<"LogicalSequence">;
/** Total-order position stamped by the single log writer on drain; unique and strictly increasing. */
export const LogicalSequence: Schema.Schema<LogicalSequence, number> =
  Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.brand("LogicalSequence"),
    Schema.annotations({
      description: "Total-order position in the event log",
    }),
  );

export type CorrelationId = string & Brand.Brand<"CorrelationId">;
/** Ties the events of one multi-event exchange (fault apply/revert pair, tool call/result pair). */
export const CorrelationId: Schema.Schema<CorrelationId, string> =
  Schema.NonEmptyString.pipe(
    Schema.brand("CorrelationId"),
    Schema.annotations({
      description: "Exchange identity across correlated events",
    }),
  );

export type WallTimeMs = number & Brand.Brand<"WallTimeMs">;
/** Wall-clock epoch milliseconds. */
export const WallTimeMs: Schema.Schema<WallTimeMs, number> = Schema.Number.pipe(
  Schema.brand("WallTimeMs"),
  Schema.annotations({ description: "Wall-clock time, epoch milliseconds" }),
);
