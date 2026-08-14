/** @file Volatile OpenFloorV1 contention, grant, and MULTICAST admission. */

import {
  MOLTZAP_VERSION,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import {
  Clock,
  Duration,
  Effect,
  Encoding,
  Fiber,
  Schema,
  Scope,
} from "effect";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { Content, ConversationId } from "../contract.js";
import {
  ReplyGrant,
  type ReplyGrant as ReplyGrantValue,
} from "../harness-runtime.js";
import {
  type Begin,
  type BeginDigest,
  ClientRepresentationError,
  decodeCanonical,
  encodeCanonical,
  EvidenceStatement,
  fingerprintReply,
  hashBeginMessage,
  makeActionBinding,
  memberCard,
  MulticastAction,
  signEvidenceMessage,
  verifyOuterMessage,
  verifyStableEvidence,
} from "./representation.js";
import {
  EngineAttentionError,
  EngineReplyError,
  type EngineProspectiveTurn,
} from "./engine-types.js";
import type {
  OpenFloorCertifiedHead,
  OpenFloorInput,
  OpenFloorMulticastCandidate,
  OpenFloorPort,
} from "./openfloor-types.js";
import type {
  RouterIngressDisposition,
  RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "./router-worker.js";

export type {
  OpenFloorActions,
  OpenFloorCertifiedHead,
  OpenFloorInput,
  OpenFloorMulticastCandidate,
  OpenFloorPort,
} from "./openfloor-types.js";

/** Protocol-fixed lifetime of one locally observed contention round. */
export const openFloorGrantTtlMillis = 90_000;

type OpenFloorIngress = RouterWorkerIngress<
  import("./representation.js").DecodedOuterBody
>;

interface OpenFloorWinner {
  readonly digest: BeginDigest;
  readonly begin: Begin;
  readonly expiresAt: number;
  readonly acknowledgments: Map<string, SignedMessageValue>;
  localAcknowledgmentQueued: boolean;
}

interface OpenFloorRound {
  readonly head: OpenFloorCertifiedHead;
  readonly winner: OpenFloorWinner;
  grant?: ReplyGrantValue;
  deliveryPending: boolean;
  deliveryComplete: boolean;
  acceptedAction?: typeof MulticastAction.Type;
  candidateDelivered: boolean;
}

interface OpenFloorAuthority {
  readonly conversationId: ConversationId;
  readonly recordHash: OpenFloorCertifiedHead["recordHash"];
  readonly beginDigest: BeginDigest;
  readonly expiresAt: number;
}

interface OpenFloorRuntime {
  readonly input: OpenFloorInput;
  readonly lifetimeScope: Scope.Scope;
  readonly heads: Map<ConversationId, OpenFloorCertifiedHead>;
  readonly pendingHeads: Set<OpenFloorCertifiedHead["recordHash"]>;
  readonly rounds: Map<ConversationId, OpenFloorRound>;
  readonly authorities: Map<ReplyGrantValue, OpenFloorAuthority>;
  readonly expiryFibers: Map<ConversationId, Fiber.RuntimeFiber<void, never>>;
  readonly gate: Effect.Semaphore;
  listenerActive: boolean;
}

interface BeginDecision {
  readonly disposition: RouterIngressDisposition;
  readonly acknowledgment?: Readonly<{
    membership: OpenFloorCertifiedHead["membership"];
    evidence: SignedMessageValue;
  }>;
  readonly expiry?: Readonly<{
    conversationId: ConversationId;
    beginDigest: BeginDigest;
    delayMillis: number;
  }>;
}

interface AcknowledgmentDecision {
  readonly disposition: RouterIngressDisposition;
  readonly delivery?: Readonly<{
    conversationId: ConversationId;
    beginDigest: BeginDigest;
    turn: EngineProspectiveTurn;
  }>;
}

interface MulticastDecision {
  readonly disposition: RouterIngressDisposition;
  readonly candidate?: OpenFloorMulticastCandidate;
}

const accepted = "accepted" as const;
const ignored = "ignored" as const;

const representationFailure = (): ClientRepresentationError =>
  new ClientRepresentationError();

const authorityUnavailable = (): EngineReplyError =>
  new EngineReplyError({ reason: "authority-unavailable" });

const defaultRandomBytes = (size: number): Uint8Array =>
  new Uint8Array(nodeRandomBytes(size));

const headAction = (head: OpenFloorCertifiedHead) =>
  head.record.actionCertifiedRecord.action;

const isHeadCoherent = (head: OpenFloorCertifiedHead): boolean => {
  const action = headAction(head);
  return (
    head.record.recordHash === head.recordHash &&
    head.record.actionCertifiedRecord.membership.conversationId ===
      head.conversationId &&
    action.conversationId === head.conversationId &&
    action.membershipHash === head.membership.hash &&
    action.anchorHash === head.currentAnchorHash
  );
};

const isLocalAuthor = (
  runtime: OpenFloorRuntime,
  head: OpenFloorCertifiedHead,
): boolean =>
  headAction(head).authorAgentId === runtime.input.localAgentCard.agentId;

const clearConversation = (
  runtime: OpenFloorRuntime,
  conversationId: ConversationId,
): void => {
  runtime.rounds.delete(conversationId);
  for (const [grant, authority] of runtime.authorities) {
    if (authority.conversationId === conversationId) {
      runtime.authorities.delete(grant);
    }
  }
};

const clearVolatile = (runtime: OpenFloorRuntime): void => {
  runtime.pendingHeads.clear();
  runtime.rounds.clear();
  runtime.authorities.clear();
};

const makeBegin = (
  head: OpenFloorCertifiedHead,
  contenderAgentId: Begin["contenderAgentId"],
): Begin => ({
  moltzapVersion: MOLTZAP_VERSION,
  kind: "begin",
  conversationId: head.conversationId,
  membershipHash: head.membership.hash,
  anchorHash: head.currentAnchorHash,
  previousRecordHash: head.recordHash,
  actionId: "MULTICAST",
  contenderAgentId,
});

const clearPendingBegin = (
  runtime: OpenFloorRuntime,
  recordHash: OpenFloorCertifiedHead["recordHash"],
): Effect.Effect<void> =>
  runtime.gate.withPermits(1)(
    Effect.sync(() => runtime.pendingHeads.delete(recordHash)),
  );

const beginIfStillEligible = (
  runtime: OpenFloorRuntime,
  head: OpenFloorCertifiedHead,
): Effect.Effect<Begin | undefined> =>
  runtime.gate.withPermits(1)(
    Effect.sync(() => {
      const retained = runtime.heads.get(head.conversationId);
      if (
        !runtime.listenerActive ||
        retained?.recordHash !== head.recordHash ||
        isLocalAuthor(runtime, head) ||
        runtime.rounds.has(head.conversationId) ||
        runtime.pendingHeads.has(head.recordHash)
      ) {
        return undefined;
      }
      runtime.pendingHeads.add(head.recordHash);
      return makeBegin(head, runtime.input.localAgentCard.agentId);
    }),
  );

const initiateHead = (
  runtime: OpenFloorRuntime,
  head: OpenFloorCertifiedHead,
): Effect.Effect<
  void,
  ClientRepresentationError | import("./store.js").EndpointStoreError
> =>
  Effect.gen(function* () {
    const consumed = yield* runtime.input.store.hasConsumedAttention({
      conversationId: head.conversationId,
      recordHash: head.recordHash,
    });
    if (consumed) {
      return;
    }
    const begin = yield* beginIfStillEligible(runtime, head);
    if (begin === undefined) {
      return;
    }
    yield* runtime.input.actions
      .queueBegin(head.membership, begin)
      .pipe(Effect.tapError(() => clearPendingBegin(runtime, head.recordHash)));
  });

const interruptFibers = (
  fibers: readonly Fiber.RuntimeFiber<void, never>[],
): Effect.Effect<void> => Fiber.interruptAll(fibers);

const installExpiry = (
  runtime: OpenFloorRuntime,
  input: NonNullable<BeginDecision["expiry"]>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkIn(
      Effect.sleep(Duration.millis(Math.max(0, input.delayMillis))).pipe(
        Effect.zipRight(
          expireRound(runtime, input.conversationId, input.beginDigest),
        ),
        Effect.catchAll(() => Effect.void),
      ),
      runtime.lifetimeScope,
    );
    const installed = yield* runtime.gate.withPermits(1)(
      Effect.sync(() => {
        const round = runtime.rounds.get(input.conversationId);
        if (round?.winner.digest !== input.beginDigest) {
          return { accepted: false as const };
        }
        const retained = runtime.expiryFibers.get(input.conversationId);
        runtime.expiryFibers.set(input.conversationId, fiber);
        return { accepted: true as const, previous: retained };
      }),
    );
    if (!installed.accepted) {
      yield* Fiber.interrupt(fiber);
    }
    if (
      installed.accepted &&
      installed.previous !== undefined &&
      installed.previous !== fiber
    ) {
      yield* Fiber.interrupt(installed.previous);
    }
  });

const expireRound = (
  runtime: OpenFloorRuntime,
  conversationId: ConversationId,
  beginDigest: BeginDigest,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const decision = yield* runtime.gate.withPermits(1)(
      Effect.sync(() => {
        const round = runtime.rounds.get(conversationId);
        if (round === undefined || round.winner.digest !== beginDigest) {
          return undefined;
        }
        if (now < round.winner.expiresAt) {
          return {
            expiry: {
              conversationId,
              beginDigest,
              delayMillis: round.winner.expiresAt - now,
            },
          };
        }
        runtime.expiryFibers.delete(conversationId);
        clearConversation(runtime, conversationId);
        runtime.pendingHeads.delete(round.head.recordHash);
        const retained = runtime.heads.get(conversationId);
        return {
          retryHead:
            retained?.recordHash === round.head.recordHash
              ? retained
              : undefined,
        };
      }),
    );
    if (decision?.expiry !== undefined) {
      yield* installExpiry(runtime, decision.expiry);
    }
    if (decision?.retryHead !== undefined) {
      yield* initiateHead(runtime, decision.retryHead);
    }
  }).pipe(Effect.catchAll(() => Effect.void));

const makeLocalAcknowledgment = (
  runtime: OpenFloorRuntime,
  round: OpenFloorRound,
): Effect.Effect<SignedMessageValue, ClientRepresentationError> =>
  signEvidenceMessage({
    statement: {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "ack",
      signerAgentId: runtime.input.localAgentCard.agentId,
      conversationId: round.head.conversationId,
      membershipHash: round.head.membership.hash,
      previousRecordHash: round.head.recordHash,
      beginDigest: round.winner.digest,
    },
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  });

const beginMatchesHead = (
  head: OpenFloorCertifiedHead,
  begin: Begin,
): boolean =>
  begin.conversationId === head.conversationId &&
  begin.membershipHash === head.membership.hash &&
  begin.anchorHash === head.currentAnchorHash &&
  begin.previousRecordHash === head.recordHash &&
  begin.actionId === "MULTICAST" &&
  begin.contenderAgentId !== headAction(head).authorAgentId &&
  memberCard(head.membership, begin.contenderAgentId) !== undefined;

const acceptBeginLocked = (
  runtime: OpenFloorRuntime,
  ingress: OpenFloorIngress,
  begin: Begin,
): Effect.Effect<BeginDecision, ClientRepresentationError> =>
  Effect.gen(function* () {
    const head = runtime.heads.get(begin.conversationId);
    if (
      head === undefined ||
      !beginMatchesHead(head, begin) ||
      ingress.message.senderAgentId !== begin.contenderAgentId
    ) {
      return { disposition: ignored };
    }
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: head.membership,
    });
    const now = yield* Clock.currentTimeMillis;
    const digest = yield* hashBeginMessage(ingress.message);
    const retained = runtime.rounds.get(begin.conversationId);
    if (retained !== undefined && now < retained.winner.expiresAt) {
      if (retained.winner.digest !== digest) {
        return { disposition: ignored };
      }
      if (retained.winner.localAcknowledgmentQueued) {
        return { disposition: accepted };
      }
      const evidence = yield* makeLocalAcknowledgment(runtime, retained);
      retained.winner.localAcknowledgmentQueued = true;
      return {
        disposition: accepted,
        acknowledgment: { membership: head.membership, evidence },
      };
    }
    if (retained !== undefined) {
      clearConversation(runtime, begin.conversationId);
    }
    const round: OpenFloorRound = {
      head,
      winner: {
        digest,
        begin,
        expiresAt: now + openFloorGrantTtlMillis,
        acknowledgments: new Map(),
        localAcknowledgmentQueued: false,
      },
      deliveryComplete: false,
      deliveryPending: false,
      candidateDelivered: false,
    };
    const evidence = yield* makeLocalAcknowledgment(runtime, round);
    round.winner.localAcknowledgmentQueued = true;
    runtime.pendingHeads.delete(head.recordHash);
    runtime.rounds.set(head.conversationId, round);
    return {
      disposition: accepted,
      acknowledgment: { membership: head.membership, evidence },
      expiry: {
        conversationId: head.conversationId,
        beginDigest: digest,
        delayMillis: openFloorGrantTtlMillis,
      },
    };
  });

const makeGrant = (
  runtime: OpenFloorRuntime,
): Effect.Effect<ReplyGrantValue, ClientRepresentationError> =>
  Effect.try({
    try: () => {
      const bytes = (runtime.input.randomBytes ?? defaultRandomBytes)(32);
      if (bytes.byteLength !== 32) {
        throw representationFailure();
      }
      return Schema.decodeUnknownSync(ReplyGrant)(
        Encoding.encodeBase64Url(bytes),
      );
    },
    catch: representationFailure,
  });

const makeUniqueGrant = (
  runtime: OpenFloorRuntime,
): Effect.Effect<ReplyGrantValue, ClientRepresentationError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const grant = yield* makeGrant(runtime);
      if (!runtime.authorities.has(grant)) {
        return grant;
      }
    }
    return yield* representationFailure();
  });

const turnForRound = (
  runtime: OpenFloorRuntime,
  round: OpenFloorRound,
  grant: ReplyGrantValue,
): Effect.Effect<EngineProspectiveTurn, ClientRepresentationError> =>
  Effect.gen(function* () {
    const peers = round.head.membership.members.filter(
      (member) => member.agentId !== runtime.input.localAgentCard.agentId,
    );
    const firstPeer = peers[0];
    const author = memberCard(
      round.head.membership,
      headAction(round.head).authorAgentId,
    );
    if (firstPeer === undefined || author === undefined) {
      return yield* representationFailure();
    }
    return {
      conversationId: round.head.conversationId,
      recordHash: round.head.recordHash,
      peers: [firstPeer, ...peers.slice(1)],
      author,
      content: headAction(round.head).content,
      replyGrant: grant,
    };
  });

const acceptAcknowledgmentLocked = (
  runtime: OpenFloorRuntime,
  ingress: OpenFloorIngress,
  message: SignedMessageValue,
): Effect.Effect<AcknowledgmentDecision, ClientRepresentationError> =>
  Effect.gen(function* () {
    const statement = yield* decodeCanonical(EvidenceStatement, message.body);
    if (statement.kind !== "ack") {
      return { disposition: ignored };
    }
    const head = runtime.heads.get(statement.conversationId);
    const round = runtime.rounds.get(statement.conversationId);
    if (head === undefined || round === undefined) {
      return { disposition: ignored };
    }
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: head.membership,
    });
    const representation = yield* Schema.encode(SignedMessage)(message).pipe(
      Effect.mapError(representationFailure),
    );
    const verified = yield* verifyStableEvidence({
      representation,
      membership: head.membership,
    });
    const now = yield* Clock.currentTimeMillis;
    if (
      verified.statement.kind !== "ack" ||
      ingress.message.senderAgentId !== verified.statement.signerAgentId ||
      now >= round.winner.expiresAt ||
      verified.statement.conversationId !== head.conversationId ||
      verified.statement.membershipHash !== head.membership.hash ||
      verified.statement.previousRecordHash !== head.recordHash ||
      verified.statement.beginDigest !== round.winner.digest
    ) {
      return { disposition: ignored };
    }
    round.winner.acknowledgments.set(
      verified.statement.signerAgentId,
      verified.message,
    );
    if (
      round.winner.acknowledgments.size !== head.membership.members.length ||
      round.winner.begin.contenderAgentId !==
        runtime.input.localAgentCard.agentId ||
      round.deliveryPending ||
      round.deliveryComplete
    ) {
      return { disposition: accepted };
    }
    const grant = round.grant ?? (yield* makeUniqueGrant(runtime));
    if (round.grant === undefined) {
      round.grant = grant;
      runtime.authorities.set(grant, {
        conversationId: head.conversationId,
        recordHash: head.recordHash,
        beginDigest: round.winner.digest,
        expiresAt: round.winner.expiresAt,
      });
    }
    round.deliveryPending = true;
    return {
      disposition: accepted,
      delivery: {
        conversationId: head.conversationId,
        beginDigest: round.winner.digest,
        turn: yield* turnForRound(runtime, round, grant),
      },
    };
  });

const finishDelivery = (
  runtime: OpenFloorRuntime,
  delivery: NonNullable<AcknowledgmentDecision["delivery"]>,
  completed: boolean,
): Effect.Effect<void> =>
  runtime.gate.withPermits(1)(
    Effect.sync(() => {
      const round = runtime.rounds.get(delivery.conversationId);
      if (round?.winner.digest !== delivery.beginDigest) {
        return;
      }
      round.deliveryPending = false;
      round.deliveryComplete = completed;
    }),
  );

const sameAction = (
  left: typeof MulticastAction.Type,
  right: typeof MulticastAction.Type,
): Effect.Effect<boolean, ClientRepresentationError> =>
  Effect.all([
    encodeCanonical(MulticastAction, left),
    encodeCanonical(MulticastAction, right),
  ]).pipe(
    Effect.map(
      ([leftBytes, rightBytes]) =>
        leftBytes.length === rightBytes.length &&
        leftBytes.every((byte, index) => byte === rightBytes[index]),
    ),
  );

const actionMatchesRound = (
  round: OpenFloorRound,
  action: typeof MulticastAction.Type,
): Effect.Effect<boolean, ClientRepresentationError> =>
  fingerprintReply(action.content).pipe(
    Effect.map(
      (fingerprint) =>
        action.conversationId === round.head.conversationId &&
        action.membershipHash === round.head.membership.hash &&
        action.anchorHash === round.head.currentAnchorHash &&
        action.previousRecordHash === round.head.recordHash &&
        action.beginDigest === round.winner.digest &&
        action.actionId === "MULTICAST" &&
        action.authorAgentId === round.winner.begin.contenderAgentId &&
        action.replyFingerprint === fingerprint,
    ),
  );

const signAction = (
  runtime: OpenFloorRuntime,
  action: typeof MulticastAction.Type,
): Effect.Effect<SignedMessageValue, ClientRepresentationError> =>
  Effect.gen(function* () {
    const binding = yield* makeActionBinding(action);
    return yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_signature",
        signerAgentId: runtime.input.localAgentCard.agentId,
        action: binding,
      },
      agentCard: runtime.input.localAgentCard,
      signingAuthority: runtime.input.signingAuthority,
    });
  });

const acceptMulticastLocked = (
  runtime: OpenFloorRuntime,
  ingress: OpenFloorIngress,
  action: typeof MulticastAction.Type,
): Effect.Effect<MulticastDecision, ClientRepresentationError> =>
  Effect.gen(function* () {
    const head = runtime.heads.get(action.conversationId);
    const round = runtime.rounds.get(action.conversationId);
    if (head === undefined || round === undefined) {
      return { disposition: ignored };
    }
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: head.membership,
    });
    const now = yield* Clock.currentTimeMillis;
    if (
      now >= round.winner.expiresAt ||
      ingress.message.senderAgentId !== action.authorAgentId ||
      round.winner.acknowledgments.size !== head.membership.members.length ||
      !(yield* actionMatchesRound(round, action))
    ) {
      return { disposition: ignored };
    }
    if (
      round.acceptedAction !== undefined &&
      !(yield* sameAction(round.acceptedAction, action))
    ) {
      return { disposition: ignored };
    }
    round.acceptedAction = action;
    if (
      action.authorAgentId === runtime.input.localAgentCard.agentId ||
      round.candidateDelivered
    ) {
      return { disposition: accepted };
    }
    round.candidateDelivered = true;
    return {
      disposition: accepted,
      candidate: {
        conversationId: action.conversationId,
        beginDigest: action.beginDigest,
        membership: head.membership,
        action,
        localActionSignature: yield* signAction(runtime, action),
      },
    };
  });

const runBeginDecision = (
  runtime: OpenFloorRuntime,
  decision: BeginDecision,
): Effect.Effect<RouterIngressDisposition, ClientRepresentationError> =>
  Effect.gen(function* () {
    if (decision.expiry !== undefined) {
      yield* installExpiry(runtime, decision.expiry);
    }
    if (decision.acknowledgment !== undefined) {
      yield* runtime.input.actions.queueEvidence(
        decision.acknowledgment.membership,
        decision.acknowledgment.evidence,
      );
    }
    return decision.disposition;
  });

const acceptIngress = (
  runtime: OpenFloorRuntime,
  ingress: OpenFloorIngress,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  (ingress.payload.kind === "evidence"
    ? runtime.gate
        .withPermits(1)(
          acceptAcknowledgmentLocked(runtime, ingress, ingress.payload.message),
        )
        .pipe(
          Effect.flatMap((decision) =>
            decision.delivery === undefined
              ? Effect.succeed(decision.disposition)
              : (() => {
                  const delivery = decision.delivery;
                  return runtime.input.actions.deliverTurn(delivery.turn).pipe(
                    Effect.tap(() => finishDelivery(runtime, delivery, true)),
                    Effect.tapError(() =>
                      finishDelivery(runtime, delivery, false),
                    ),
                    Effect.as(decision.disposition),
                  );
                })(),
          ),
        )
    : (() => {
        switch (ingress.payload.packet.kind) {
          case "begin":
            return runtime.gate
              .withPermits(1)(
                acceptBeginLocked(runtime, ingress, ingress.payload.packet),
              )
              .pipe(
                Effect.flatMap((decision) =>
                  runBeginDecision(runtime, decision),
                ),
              );
          case "multicast_proposal":
            return runtime.gate
              .withPermits(1)(
                acceptMulticastLocked(
                  runtime,
                  ingress,
                  ingress.payload.packet.action,
                ),
              )
              .pipe(
                Effect.flatMap((decision) =>
                  decision.candidate === undefined
                    ? Effect.succeed(decision.disposition)
                    : runtime.input.actions
                        .onMulticastCandidate(decision.candidate)
                        .pipe(Effect.as(decision.disposition)),
                ),
              );
          default:
            return Effect.succeed(ignored);
        }
      })()
  ).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
  );

const registerHead = (
  runtime: OpenFloorRuntime,
  head: OpenFloorCertifiedHead,
): Effect.Effect<void, EngineAttentionError> =>
  Effect.gen(function* () {
    const interrupted = yield* runtime.gate.withPermits(1)(
      Effect.gen(function* () {
        if (!isHeadCoherent(head)) {
          return yield* Effect.fail(new EngineAttentionError());
        }
        const previous = runtime.heads.get(head.conversationId);
        const changed = previous?.recordHash !== head.recordHash;
        const expiry = changed
          ? runtime.expiryFibers.get(head.conversationId)
          : undefined;
        if (changed) {
          runtime.expiryFibers.delete(head.conversationId);
          clearConversation(runtime, head.conversationId);
          if (previous !== undefined) {
            runtime.pendingHeads.delete(previous.recordHash);
          }
        }
        runtime.heads.set(head.conversationId, head);
        return expiry;
      }),
    );
    if (interrupted !== undefined) {
      yield* Fiber.interrupt(interrupted);
    }
    yield* initiateHead(runtime, head).pipe(
      Effect.mapError(() => new EngineAttentionError()),
    );
  });

const attachListener = (
  runtime: OpenFloorRuntime,
): Effect.Effect<void, EngineAttentionError> =>
  Effect.gen(function* () {
    const heads = yield* runtime.gate.withPermits(1)(
      Effect.sync(() => {
        runtime.listenerActive = true;
        return [...runtime.heads.values()];
      }),
    );
    yield* Effect.forEach(
      heads,
      (head) =>
        initiateHead(runtime, head).pipe(
          Effect.mapError(() => new EngineAttentionError()),
        ),
      { concurrency: 1, discard: true },
    );
  });

const abandon = (
  runtime: OpenFloorRuntime,
  detach: boolean,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fibers = yield* runtime.gate.withPermits(1)(
      Effect.sync(() => {
        if (detach) {
          runtime.listenerActive = false;
        }
        const retained = [...runtime.expiryFibers.values()];
        runtime.expiryFibers.clear();
        clearVolatile(runtime);
        return retained;
      }),
    );
    yield* interruptFibers(fibers);
  });

const admitReply = (
  runtime: OpenFloorRuntime,
  grant: ReplyGrantValue,
  content: Content,
): Effect.Effect<OpenFloorMulticastCandidate, EngineReplyError> =>
  runtime.gate.withPermits(1)(
    Effect.gen(function* () {
      const authority = runtime.authorities.get(grant);
      const now = yield* Clock.currentTimeMillis;
      const round =
        authority === undefined
          ? undefined
          : runtime.rounds.get(authority.conversationId);
      const head =
        authority === undefined
          ? undefined
          : runtime.heads.get(authority.conversationId);
      if (
        authority === undefined ||
        now >= authority.expiresAt ||
        round === undefined ||
        head === undefined ||
        head.recordHash !== authority.recordHash ||
        round.winner.digest !== authority.beginDigest ||
        round.winner.acknowledgments.size !== head.membership.members.length
      ) {
        return yield* Effect.fail(authorityUnavailable());
      }
      runtime.authorities.delete(grant);
      const action: typeof MulticastAction.Type = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "multicast_action",
        conversationId: head.conversationId,
        membershipHash: head.membership.hash,
        anchorHash: head.currentAnchorHash,
        previousRecordHash: head.recordHash,
        beginDigest: authority.beginDigest,
        actionId: "MULTICAST",
        authorAgentId: runtime.input.localAgentCard.agentId,
        content,
        replyFingerprint: yield* fingerprintReply(content).pipe(
          Effect.mapError(
            () => new EngineReplyError({ reason: "representation" }),
          ),
        ),
      };
      round.acceptedAction = action;
      return {
        conversationId: head.conversationId,
        beginDigest: authority.beginDigest,
        membership: head.membership,
        action,
        localActionSignature: yield* signAction(runtime, action).pipe(
          Effect.mapError(
            () => new EngineReplyError({ reason: "representation" }),
          ),
        ),
      };
    }),
  );

/** Build one endpoint-local OpenFloorV1 fold over engine-owned side effects. */
export const makeOpenFloor = (
  input: OpenFloorInput,
): Effect.Effect<OpenFloorPort, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime: OpenFloorRuntime = {
      input,
      lifetimeScope: yield* Effect.scope,
      heads: new Map(),
      pendingHeads: new Set(),
      rounds: new Map(),
      authorities: new Map(),
      expiryFibers: new Map(),
      gate: yield* Effect.makeSemaphore(1),
      listenerActive: false,
    };
    return Object.freeze({
      listenerAttached: attachListener(runtime),
      listenerDetached: abandon(runtime, true),
      certifiedHead: (head: OpenFloorCertifiedHead) =>
        registerHead(runtime, head),
      acceptIngress: (ingress: OpenFloorIngress) =>
        acceptIngress(runtime, ingress),
      admitReply: (grant: ReplyGrantValue, content: Content) =>
        admitReply(runtime, grant, content),
      abandon: abandon(runtime, false),
    });
  });
