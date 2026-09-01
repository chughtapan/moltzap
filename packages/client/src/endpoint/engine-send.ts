/** @file Address resolution, immutable intent binding, and proposal creation. */

import { AgentCard, MOLTZAP_VERSION, SignedMessage } from "@moltzap/identity";
import { Deferred, Effect, Schema } from "effect";
import type {
  EngineConversation,
  EnginePostIntent,
  EngineRuntime,
} from "./engine-types.js";
import type { RouterWorkerUnavailableError } from "./router-worker/index.js";
import type {
  ConversationFoundation,
  EndpointStoreError,
  OutboundMessageInput,
  PostIntent as StoredPostIntent,
} from "./store.js";
import { SendError, type SendInput } from "../contract.js";
import { resolveMessageAddress } from "./addressing/index.js";
import { currentRecoveryBarrier } from "./recovery/barrier.js";
import {
  type ActionCertifiedRecord,
  type ActionCore,
  type ActionHash,
  type CertifiedRecord,
  deriveConversationId,
  type DirectPacket,
  encodeCanonical,
  GenesisAnchorBody,
  hashAction,
  hashAnchor,
  hashPostIntent,
  MembershipDescriptor as MembershipDescriptorSchema,
  mintPostId,
  type PostIntent,
  PostIntent as PostIntentSchema,
  signOuterEvidence,
  signOuterPacket,
  type VerifiedMembership,
  verifyMembershipDescriptor,
} from "./representation.js";

const sendReasonByStoreReason = {
  closed: "persistence-failed",
  conflict: "persistence-failed",
  corrupt: "persistence-failed",
  incompatible: "persistence-failed",
  "invalid-continuation": "persistence-failed",
  "invalid-input": "persistence-failed",
  "not-found": "persistence-failed",
  persistence: "persistence-failed",
} as const satisfies Readonly<
  Record<EndpointStoreError["reason"], SendError["reason"]>
>;

function storeFailure(error: EndpointStoreError): SendError {
  return new SendError({ reason: sendReasonByStoreReason[error.reason] });
}

const representationFailure = (): SendError =>
  new SendError({ reason: "certification-unavailable" });

type ResolvedAddress = Effect.Effect.Success<
  ReturnType<typeof resolveMessageAddress>
>;

const buildMembership = (runtime: EngineRuntime, resolved: ResolvedAddress) =>
  Effect.gen(function* () {
    const memberAgentIds = resolved.memberCards.map((card) => card.agentId);
    const firstAgentId = memberAgentIds[0];
    const secondAgentId = memberAgentIds[1];
    if (firstAgentId === undefined || secondAgentId === undefined) {
      return yield* Effect.fail(
        new SendError({ reason: "membership-invalid" }),
      );
    }
    const conversationId = yield* deriveConversationId([
      firstAgentId,
      secondAgentId,
      ...memberAgentIds.slice(2),
    ]).pipe(Effect.mapError(representationFailure));
    const encodedCards = yield* Effect.forEach(
      resolved.memberCards,
      (card) => Schema.encode(AgentCard)(card),
      { concurrency: 1 },
    ).pipe(Effect.mapError(representationFailure));
    const firstCard = encodedCards[0];
    const secondCard = encodedCards[1];
    if (firstCard === undefined || secondCard === undefined) {
      return yield* Effect.fail(
        new SendError({ reason: "membership-invalid" }),
      );
    }
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptorSchema)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "membership_descriptor",
      conversationId,
      members: [firstCard, secondCard, ...encodedCards.slice(2)],
    }).pipe(Effect.mapError(representationFailure));
    const membership = yield* verifyMembershipDescriptor(
      descriptor,
      runtime.input.registrySignerPublicKey,
    ).pipe(Effect.mapError(representationFailure));
    return membership;
  });

const resolveMembership = (runtime: EngineRuntime, input: SendInput) =>
  resolveMessageAddress({
    localAgentCard: runtime.input.localAgentCard,
    registry: runtime.input.registry,
    to: input.to,
  }).pipe(Effect.flatMap((resolved) => buildMembership(runtime, resolved)));

function enqueueOuterMessage(
  runtime: EngineRuntime,
  conversationId: EngineConversation["conversationId"],
  message: typeof SignedMessage.Type,
): Effect.Effect<void, SendError> {
  return outboundInput(conversationId, message).pipe(
    Effect.flatMap((input) =>
      runtime.input.store
        .enqueueOutbound(input)
        .pipe(Effect.mapError(storeFailure)),
    ),
    Effect.flatMap((outbound) => signalOutbound(runtime, outbound.outboundId)),
  );
}

function outboundInput(
  conversationId: EngineConversation["conversationId"],
  message: typeof SignedMessage.Type,
): Effect.Effect<OutboundMessageInput, SendError> {
  return encodeCanonical(SignedMessage, message).pipe(
    Effect.mapError(representationFailure),
    Effect.map((canonicalSignedMessage) => ({
      conversationId,
      messageId: message.messageId,
      canonicalSignedMessage,
    })),
  );
}

function signalOutbound(
  runtime: EngineRuntime,
  outboundId: string,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (!runtime.outbound.includes(outboundId)) {
      runtime.outbound.push(outboundId);
    }
  }).pipe(
    Effect.zipRight(runtime.outboundSignal.offer(undefined)),
    Effect.asVoid,
  );
}

function recordHash(
  packet: ActionCertifiedRecord | CertifiedRecord,
): ActionCertifiedRecord["recordHash"] {
  switch (packet.kind) {
    case "action_certified_record":
      return packet.recordHash;
    case "certified_record":
      return packet.actionCertifiedRecord.recordHash;
    default: {
      const exhaustive: never = packet;
      return exhaustive;
    }
  }
}

function disseminationKind(
  packet: ActionCertifiedRecord | CertifiedRecord,
): "action-certified-record" | "certified-record" {
  switch (packet.kind) {
    case "action_certified_record":
      return "action-certified-record";
    case "certified_record":
      return "certified-record";
    default: {
      const exhaustive: never = packet;
      return exhaustive;
    }
  }
}

/**
 * Queue one direct protocol packet for all fixed members.
 * @param runtime Engine state and local signing authority.
 * @param conversation Verified conversation and fixed-member recipients.
 * @param packet Closed protocol packet to disseminate.
 * @returns Completion after the complete outer message is durably staged.
 */
const queuePacket = (
  runtime: EngineRuntime,
  conversation: EngineConversation,
  packet: DirectPacket,
): Effect.Effect<void, SendError> =>
  signOuterPacket({
    packet,
    membership: conversation.membership,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.mapError(representationFailure),
    Effect.flatMap((message) =>
      enqueueOuterMessage(runtime, conversation.conversationId, message),
    ),
  );

/**
 * Attach a certified record packet to its durable dissemination obligation.
 * @param runtime Engine state and local signing authority.
 * @param conversation Verified conversation and fixed-member recipients.
 * @param packet Record packet whose state transition retained the obligation.
 * @returns Completion after the exact outer envelope is durably attached.
 */
export const queueCertifiedPacket = (
  runtime: EngineRuntime,
  conversation: EngineConversation,
  packet: ActionCertifiedRecord | CertifiedRecord,
): Effect.Effect<void, SendError> =>
  signOuterPacket({
    packet,
    membership: conversation.membership,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.mapError(representationFailure),
    Effect.flatMap((message) =>
      outboundInput(conversation.conversationId, message).pipe(
        Effect.flatMap((input) =>
          runtime.input.store
            .enqueueDisseminationOutbound(
              {
                conversationId: conversation.conversationId,
                recordHash: recordHash(packet),
                kind: disseminationKind(packet),
              },
              input,
            )
            .pipe(Effect.mapError(storeFailure)),
        ),
      ),
    ),
    Effect.flatMap((outbound) => signalOutbound(runtime, outbound.outboundId)),
  );

/**
 * Queue stable inner evidence without changing its signer attribution.
 * @param runtime Engine state and local signing authority.
 * @param conversation Verified conversation and fixed-member recipients.
 * @param evidence Stable self-addressed evidence message.
 * @returns Completion after the complete outer message is durably staged.
 */
export const queueEvidence = (
  runtime: EngineRuntime,
  conversation: EngineConversation,
  evidence: SignedMessage,
): Effect.Effect<void, SendError> =>
  signOuterEvidence({
    evidence,
    membership: conversation.membership,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.mapError(representationFailure),
    Effect.flatMap((message) =>
      enqueueOuterMessage(runtime, conversation.conversationId, message),
    ),
  );

const proposalAction = (
  conversation: EngineConversation,
  intent: PostIntent,
): Effect.Effect<ActionCore, SendError> => {
  const head = conversation.head;
  if (head === undefined) {
    const anchor = conversation.currentAnchor;
    if (anchor.kind !== "genesis_anchor_body") {
      return Effect.fail(representationFailure());
    }
    return hashPostIntent(intent).pipe(
      Effect.mapError(representationFailure),
      Effect.map((postIntentHash) => {
        const action: ActionCore = {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "GENESIS",
          conversationId: conversation.conversationId,
          membership: conversation.membership.descriptor,
          anchor,
          previousRecordHash: null,
          postIntent: intent,
          postIntentHash,
        };
        return action;
      }),
    );
  }
  return hashPostIntent(intent).pipe(
    Effect.mapError(representationFailure),
    Effect.map((postIntentHash) => {
      const action: ActionCore = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "POST",
        conversationId: conversation.conversationId,
        membershipHash: conversation.membership.hash,
        anchorHash:
          conversation.currentAnchor.kind === "genesis_anchor_body"
            ? head.record.actionCertifiedRecord.recordCore.anchorHash
            : conversation.currentAnchor.anchorHash,
        previousRecordHash: head.recordHash,
        postIntent: intent,
        postIntentHash,
      };
      return action;
    }),
  );
};

/**
 * Rebase one unchanged local intent against the conversation's current head.
 * @param runtime Current engine state and protocol dependencies.
 * @param localIntent Durable immutable post intent awaiting certification.
 * @returns The predecessor-bound action hash proposed for this attempt.
 */
export const proposeIntent = (
  runtime: EngineRuntime,
  localIntent: EnginePostIntent,
): Effect.Effect<ActionHash, SendError> =>
  Effect.gen(function* () {
    const conversation = runtime.conversations.get(
      localIntent.intent.conversationId,
    );
    if (conversation === undefined) {
      return yield* Effect.fail(representationFailure());
    }
    const action = yield* proposalAction(conversation, localIntent.intent);
    const actionHash = yield* hashAction(action).pipe(
      Effect.mapError(representationFailure),
    );
    if (localIntent.proposedActionHash === actionHash) {
      return actionHash;
    }
    yield* queueAuthorizedProposal(runtime, {
      conversation,
      localIntent,
      action,
      actionHash,
    });
    return actionHash;
  }).pipe(Effect.withSpan("proposeIntent"));

interface AuthorizedProposal {
  readonly conversation: EngineConversation;
  readonly localIntent: EnginePostIntent;
  readonly action: ActionCore;
  readonly actionHash: ActionHash;
}

function queueAuthorizedProposal(
  runtime: EngineRuntime,
  proposal: AuthorizedProposal,
): Effect.Effect<void, SendError> {
  return Effect.gen(function* () {
    yield* authorizeAction(runtime, proposal);
    yield* Effect.uninterruptible(
      queuePacket(runtime, proposal.conversation, {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_proposal",
        action: proposal.action,
      }).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            proposal.localIntent.proposedActionHash = proposal.actionHash;
          }),
        ),
      ),
    );
  });
}

function authorizeAction(
  runtime: EngineRuntime,
  proposal: AuthorizedProposal,
): Effect.Effect<void, SendError> {
  return runtime.input
    .actionPolicy({
      action: proposal.action,
      membership: proposal.conversation.membership,
    })
    .pipe(
      Effect.flatMap((policyDecision) => {
        switch (policyDecision) {
          case "sign":
            return Effect.void;
          case "refuse":
            return Effect.fail(
              new SendError({ reason: "certification-unavailable" }),
            );
          default: {
            const exhaustive: never = policyDecision;
            return exhaustive;
          }
        }
      }),
    );
}

const createConversation = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
): Effect.Effect<
  Readonly<{
    conversation: EngineConversation;
    foundation: ConversationFoundation;
  }>,
  SendError
> =>
  Effect.gen(function* () {
    const routerAnchor = yield* runtime.input.routerWorker.currentAnchor.pipe(
      Effect.mapError(currentAnchorFailure),
    );
    const anchor = yield* Schema.decodeUnknown(GenesisAnchorBody)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "genesis_anchor_body",
      conversationId: membership.descriptor.conversationId,
      membershipHash: membership.hash,
      routerInstanceId: routerAnchor.routerInstanceId,
    }).pipe(Effect.mapError(representationFailure));
    const anchorHash = yield* hashAnchor(anchor).pipe(
      Effect.mapError(representationFailure),
    );
    const foundation: ConversationFoundation = {
      conversationId: membership.descriptor.conversationId,
      membershipHash: membership.hash,
      canonicalMembership: yield* encodeCanonical(
        MembershipDescriptorSchema,
        membership.descriptor,
      ).pipe(Effect.mapError(representationFailure)),
      anchorHash,
      canonicalAnchor: yield* encodeCanonical(GenesisAnchorBody, anchor).pipe(
        Effect.mapError(representationFailure),
      ),
    };
    return {
      foundation,
      conversation: {
        conversationId: membership.descriptor.conversationId,
        membership,
        currentAnchor: anchor,
      },
    };
  });

function currentAnchorFailure(error: RouterWorkerUnavailableError): SendError {
  const reasonByTag = {
    RouterWorkerUnavailableError: "network-unavailable",
  } as const satisfies Readonly<
    Record<RouterWorkerUnavailableError["_tag"], SendError["reason"]>
  >;
  return new SendError({ reason: reasonByTag[error._tag] });
}

/**
 * Persist an addressed intent and return its durable completion latch.
 * @param runtime Current engine state and protocol dependencies.
 * @param input Explicit addressed send requested by the host.
 * @returns A latch completed when the exact post becomes locally certified.
 */
export const prepareSend = (
  runtime: EngineRuntime,
  input: SendInput,
): Effect.Effect<Deferred.Deferred<undefined, SendError>, SendError> =>
  prepareIntent(runtime, input).pipe(
    Effect.flatMap((prepared) => activateIntent(runtime, prepared)),
    Effect.withSpan("prepareSend"),
  );

interface PreparedSend {
  readonly membership: VerifiedMembership;
  readonly intent: PostIntent;
  readonly canonicalIntent: EnginePostIntent["canonicalIntent"];
}

function prepareIntent(
  runtime: EngineRuntime,
  input: SendInput,
): Effect.Effect<PreparedSend, SendError> {
  return Effect.gen(function* () {
    const membership = yield* resolveMembership(runtime, input);
    const postId = yield* mintPostId().pipe(
      Effect.mapError(representationFailure),
    );
    const intent = yield* Schema.decodeUnknown(PostIntentSchema)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "post_intent",
      conversationId: membership.descriptor.conversationId,
      membershipHash: membership.hash,
      authorAgentId: runtime.input.localAgentCard.agentId,
      postId,
      content: input.content,
    }).pipe(Effect.mapError(representationFailure));
    const canonicalIntent = yield* encodeCanonical(
      PostIntentSchema,
      intent,
    ).pipe(Effect.mapError(representationFailure));
    return { membership, intent, canonicalIntent };
  });
}

function storedIntent(prepared: PreparedSend): StoredPostIntent {
  return {
    conversationId: prepared.intent.conversationId,
    membershipHash: prepared.intent.membershipHash,
    authorAgentId: prepared.intent.authorAgentId,
    postId: prepared.intent.postId,
    canonicalIntent: prepared.canonicalIntent,
  };
}

function bindPreparedIntent(
  runtime: EngineRuntime,
  prepared: PreparedSend,
): Effect.Effect<EngineConversation, SendError> {
  return Effect.gen(function* () {
    const retained = runtime.conversations.get(prepared.intent.conversationId);
    if (retained !== undefined) {
      if (retained.membership.hash !== prepared.membership.hash) {
        return yield* Effect.fail(
          new SendError({ reason: "certification-unavailable" }),
        );
      }
      yield* runtime.input.store
        .bindPostIntent({
          kind: "existing-conversation",
          intent: storedIntent(prepared),
        })
        .pipe(Effect.mapError(storeFailure));
      return retained;
    }
    const created = yield* createConversation(runtime, prepared.membership);
    yield* runtime.input.store
      .bindPostIntent({
        kind: "new-conversation",
        foundation: created.foundation,
        intent: storedIntent(prepared),
      })
      .pipe(Effect.mapError(storeFailure));
    yield* Effect.sync(() => {
      runtime.conversations.set(
        created.conversation.conversationId,
        created.conversation,
      );
    });
    return created.conversation;
  });
}

type IntentActivation =
  | Readonly<{
      kind: "ready";
      completion: Deferred.Deferred<undefined, SendError>;
    }>
  | Readonly<{
      kind: "waiting";
      barrier: Deferred.Deferred<undefined>;
    }>;

function activateIntent(
  runtime: EngineRuntime,
  prepared: PreparedSend,
): Effect.Effect<Deferred.Deferred<undefined, SendError>, SendError> {
  return runtime.gate
    .withPermits(1)(
      Effect.uninterruptible(activateIntentOnce(runtime, prepared)),
    )
    .pipe(
      Effect.flatMap((activation) => {
        switch (activation.kind) {
          case "ready":
            return Effect.succeed(activation.completion);
          case "waiting":
            return Deferred.await(activation.barrier).pipe(
              Effect.zipRight(activateIntent(runtime, prepared)),
            );
          default: {
            const exhaustive: never = activation;
            return exhaustive;
          }
        }
      }),
    );
}

function activateIntentOnce(
  runtime: EngineRuntime,
  prepared: PreparedSend,
): Effect.Effect<IntentActivation, SendError> {
  const { canonicalIntent, intent } = prepared;
  return Effect.gen(function* () {
    const barrier = currentRecoveryBarrier(runtime);
    if (barrier !== undefined) {
      return { kind: "waiting", barrier } satisfies IntentActivation;
    }
    yield* bindPreparedIntent(runtime, prepared);
    const retained = runtime.intents.get(intent.postId);
    if (retained !== undefined) {
      if (runtime.completedPostIds.has(intent.postId)) {
        yield* Deferred.succeed(retained.completion, undefined);
      } else {
        yield* proposeIntent(runtime, retained);
      }
      return {
        kind: "ready",
        completion: retained.completion,
      } satisfies IntentActivation;
    }
    const completion = yield* Deferred.make<undefined, SendError>();
    const localIntent: EnginePostIntent = {
      intent,
      canonicalIntent,
      completion,
    };
    if (runtime.completedPostIds.has(intent.postId)) {
      yield* Effect.sync(() => {
        runtime.intents.set(intent.postId, localIntent);
      });
      yield* Deferred.succeed(completion, undefined);
    } else {
      yield* Effect.sync(() => {
        runtime.intents.set(intent.postId, localIntent);
      });
      yield* proposeIntent(runtime, localIntent);
    }
    return { kind: "ready", completion } satisfies IntentActivation;
  });
}
