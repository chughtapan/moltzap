/** @file Recovery of durable certified-record dissemination obligations. */

import { Effect, Schema } from "effect";
import type { EngineActionFold, EngineRuntime } from "./engine-types.js";
import type { DisseminationObligation } from "./store.js";
import {
  makeActionCertifiedRecord,
  recordAnchorHash,
} from "./engine-durability.js";
import { queueCertifiedPacket } from "./engine-send.js";
import {
  type ActionCertifiedRecord,
  type CertifiedRecord,
  ConversationId,
  RecordHash,
} from "./representation.js";
import { RouterWorkerPersistenceError } from "./router-worker/index.js";

interface VerifiedDisseminationObligation {
  readonly fold: EngineActionFold;
  readonly recordHash: typeof RecordHash.Type;
}

/**
 * Attach every durable certification obligation that lacks an outer envelope.
 * @param runtime Recovered engine state and durable protocol dependencies.
 * @returns Completion after every obligation has one exact retained outbox row.
 */
export function resumeDisseminationObligations(
  runtime: EngineRuntime,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return runtime.gate.withPermits(1)(
    runtime.input.store.recover().pipe(
      Effect.mapError(persistenceFailure),
      Effect.flatMap((recovery) =>
        Effect.forEach(
          recovery.disseminationObligations,
          (obligation) => attachObligation(runtime, obligation),
          { concurrency: 1, discard: true },
        ),
      ),
    ),
  );
}

function attachObligation(
  runtime: EngineRuntime,
  obligation: DisseminationObligation,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.gen(function* () {
    const { fold, recordHash } = yield* obligationFold(runtime, obligation);
    const packet = yield* packetForObligation(fold, obligation, recordHash);
    yield* Effect.uninterruptible(
      queueCertifiedPacket(runtime, fold.conversation, packet).pipe(
        Effect.mapError(persistenceFailure),
        Effect.zipRight(markQueued(fold, obligation.kind)),
      ),
    );
  });
}

function obligationFold(
  runtime: EngineRuntime,
  obligation: DisseminationObligation,
): Effect.Effect<
  VerifiedDisseminationObligation,
  RouterWorkerPersistenceError
> {
  return Effect.all({
    conversationId: Schema.decodeUnknown(ConversationId)(
      obligation.conversationId,
    ).pipe(Effect.mapError(persistenceFailure)),
    recordHash: Schema.decodeUnknown(RecordHash)(obligation.recordHash).pipe(
      Effect.mapError(persistenceFailure),
    ),
  }).pipe(
    Effect.flatMap(({ conversationId, recordHash }) => {
      const fold = runtime.recordFolds.get(recordHash);
      return fold !== undefined &&
        fold.conversation.conversationId === conversationId &&
        fold.recordHash === recordHash
        ? Effect.succeed({ fold, recordHash })
        : Effect.fail(persistenceFailure());
    }),
  );
}

function packetForObligation(
  fold: EngineActionFold,
  obligation: DisseminationObligation,
  recordHash: typeof RecordHash.Type,
): Effect.Effect<
  ActionCertifiedRecord | CertifiedRecord,
  RouterWorkerPersistenceError
> {
  switch (obligation.kind) {
    case "action-certified-record":
      return recordAnchorHash(fold).pipe(
        Effect.mapError(persistenceFailure),
        Effect.flatMap((anchorHash) =>
          makeActionCertifiedRecord(fold, anchorHash).pipe(
            Effect.mapError(persistenceFailure),
          ),
        ),
        Effect.filterOrFail(
          (record) => record.recordHash === recordHash,
          persistenceFailure,
        ),
      );
    case "certified-record": {
      const record = fold.certifiedRecord;
      return record !== undefined &&
        record.actionCertifiedRecord.recordHash === recordHash
        ? Effect.succeed(record)
        : Effect.fail(persistenceFailure());
    }
    default: {
      const exhaustive: never = obligation.kind;
      return exhaustive;
    }
  }
}

function markQueued(
  fold: EngineActionFold,
  kind: DisseminationObligation["kind"],
): Effect.Effect<void> {
  return Effect.sync(() => {
    switch (kind) {
      case "action-certified-record":
        fold.actionCertifiedRecordQueued = true;
        return;
      case "certified-record":
        fold.certifiedRecordQueued = true;
        return;
      default: {
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
  });
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}
