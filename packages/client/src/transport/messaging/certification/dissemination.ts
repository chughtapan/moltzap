/** @file Recovery of durable action-certified-record send obligations. */

import { Effect, Schema } from "effect";
import type { DisseminationObligation } from "../../../store/index.js";
import type { EngineActionFold, EngineRuntime } from "../runtime/index.js";
import { RouterWorkerPersistenceError } from "../../router/index.js";
import {
  type ActionCertifiedRecord,
  type ConversationId,
  RecordHash,
} from "../../wire/index.js";
import {
  makeActionCertifiedRecord,
  recordAnchorHash,
} from "../history/index.js";

/**
 * Attach every durable certification obligation that lacks an outer envelope.
 * @param runtime Recovered engine state and durable protocol dependencies.
 * @param conversationId The one conversation to resume; every conversation
 *     when omitted.
 * @returns Completion after every obligation has one exact retained outbox row.
 */
export function resumeDisseminationObligations(
  runtime: EngineRuntime,
  conversationId?: ConversationId,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return runtime.gate.withPermits(1)(
    runtime.input.store.recover().pipe(
      Effect.mapError(persistenceFailure),
      Effect.flatMap((recovery) =>
        Effect.forEach(
          recovery.disseminationObligations.filter(
            (obligation) =>
              conversationId === undefined ||
              obligation.conversationId === conversationId,
          ),
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
    const fold = yield* obligationFold(runtime, obligation);
    const packet = yield* packetForObligation(fold);
    yield* Effect.uninterruptible(
      runtime.outbox
        .queueActionCertifiedRecord(fold.conversation, packet)
        .pipe(Effect.mapError(persistenceFailure)),
    );
  });
}

function obligationFold(
  runtime: EngineRuntime,
  obligation: DisseminationObligation,
): Effect.Effect<EngineActionFold, RouterWorkerPersistenceError> {
  return Schema.decodeUnknown(RecordHash)(obligation.recordHash).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((recordHash) => {
      const fold = runtime.recordFolds.get(recordHash);
      return fold?.conversation.conversationId === obligation.conversationId &&
        fold.recordHash === recordHash
        ? Effect.succeed(fold)
        : Effect.fail(persistenceFailure());
    }),
  );
}

function packetForObligation(
  fold: EngineActionFold,
): Effect.Effect<ActionCertifiedRecord, RouterWorkerPersistenceError> {
  return recordAnchorHash(fold).pipe(
    Effect.flatMap((anchorHash) => makeActionCertifiedRecord(fold, anchorHash)),
    Effect.mapError(persistenceFailure),
    Effect.filterOrFail(
      (record) => record.recordHash === fold.recordHash,
      persistenceFailure,
    ),
  );
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}
