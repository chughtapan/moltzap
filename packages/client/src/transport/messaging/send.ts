/** @file Address resolution, immutable intent binding, and proposal creation. */

import { AgentCard, MOLTZAP_VERSION } from "@moltzap/identity";
import { Deferred, Duration, Effect, Schema } from "effect";
import type {
  ConversationFoundation,
  EndpointStoreError,
  PostIntent as StoredPostIntent,
} from "../../store/index.js";
import type { RouterWorkerUnavailableError } from "../router/index.js";
import type { MessageAddressInput } from "../wire/values.js";
import type {
  EngineConversation,
  EnginePostIntent,
  EngineRuntime,
} from "./runtime/index.js";
import {
  type ActionCore,
  type ActionHash,
  type Content,
  deriveConversationId,
  encodeCanonical,
  GenesisAnchorBody,
  hashAction,
  hashAnchor,
  hashPostIntent,
  MembershipDescriptor as MembershipDescriptorSchema,
  mintPostId,
  type PostId,
  type PostIntent,
  PostIntent as PostIntentSchema,
  type RecordHash,
  type VerifiedMembership,
  verifyMembershipDescriptor,
} from "../wire/index.js";
import { resolveMessageAddress } from "./address.js";
import { SendError } from "./errors.js";
import { pendingRecoveryFence } from "./recovery/barrier.js";

/**
 * One post the engine certifies: its address and its complete content. The
 * collective layer above the engine builds the content, so the engine never
 * reads the collective part.
 */
export interface EngineSendInput {
  readonly to: MessageAddressInput;
  readonly content: Content;
}

/** A locally certified post: its minted identity and its stored record's hash. */
export interface EngineSentPost {
  readonly postId: PostId;
  readonly recordHash: RecordHash;
}

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

/**
 * How long a send waits for the Router worker to attach before failing as
 * `network-unavailable`.
 *
 * A cold-start attach can span a Router tail hold, `HOLD_DURATION` in
 * `@moltzap/router`, and the daemon's own `ROUTER_POLL_TIMEOUT`, so a bound
 * near either one fails sends that are merely early. It stays under the MCP
 * SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC`, the deadline a host client applies to
 * the tool call, so the host receives this closed failure rather than a
 * transport timeout it cannot classify, and the remaining margin covers the
 * send itself.
 */
const ROUTER_ATTACH_TIMEOUT = Duration.seconds(45);

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

const resolveCards = (runtime: EngineRuntime, to: MessageAddressInput) =>
  resolveMessageAddress({
    localAgentCard: runtime.input.localAgentCard,
    registry: runtime.input.registry,
    to,
  });

/**
 * Resolve an address to its members' Registry cards without sending, failing
 * with the `SendError` a send to the same address would fail with.
 */
export const resolveAddress = (
  runtime: EngineRuntime,
  to: MessageAddressInput,
): Effect.Effect<void, SendError> =>
  resolveCards(runtime, to).pipe(Effect.asVoid);

const resolveMembership = (runtime: EngineRuntime, input: EngineSendInput) =>
  resolveCards(runtime, input.to).pipe(
    Effect.flatMap((resolved) => buildMembership(runtime, resolved)),
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
      runtime.outbox
        .queuePacket(proposal.conversation, {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "action_proposal",
          action: proposal.action,
        })
        .pipe(
          Effect.catchTags({
            EndpointStoreError: (error) => Effect.fail(storeFailure(error)),
            ClientRepresentationError: () =>
              Effect.fail(representationFailure()),
          }),
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

// Registration and daemon restart both admit sends before the worker's first
// successful poll, and every send needs an attached worker: a new conversation
// reads the current anchor, an existing one transmits through the worker. The
// wait runs before `activateIntent` takes the engine gate, because the worker
// reaches `active` only after recovery that needs that same gate; waiting while
// holding it would stall the attachment awaited.
const awaitRouterAttachment = (
  runtime: EngineRuntime,
): Effect.Effect<void, SendError> =>
  runtime.input.routerWorker.currentAnchor.pipe(
    Effect.catchTag("RouterWorkerUnavailableError", () =>
      runtime.input.routerWorker.awaitAnchor.pipe(
        Effect.timeoutFail({
          duration: ROUTER_ATTACH_TIMEOUT,
          onTimeout: () => new SendError({ reason: "network-unavailable" }),
        }),
      ),
    ),
    Effect.asVoid,
  );

/**
 * One durably bound send: its minted identity and its completion latch, which
 * yields the hash of the post's locally stored certified record.
 */
export interface PreparedSendHandle {
  readonly postId: PostId;
  readonly completion: Deferred.Deferred<RecordHash, SendError>;
}

/**
 * Persist an addressed intent and return its durable completion latch.
 * The latch completes when the minted post becomes locally certified.
 */
export const prepareSend = (
  runtime: EngineRuntime,
  input: EngineSendInput,
): Effect.Effect<PreparedSendHandle, SendError> =>
  awaitRouterAttachment(runtime).pipe(
    Effect.zipRight(prepareIntent(runtime, input)),
    Effect.flatMap((prepared) =>
      activateIntent(runtime, prepared).pipe(
        Effect.map((completion) => ({
          postId: prepared.intent.postId,
          completion,
        })),
      ),
    ),
    Effect.withSpan("prepareSend"),
  );

interface PreparedSend {
  readonly membership: VerifiedMembership;
  readonly intent: PostIntent;
  readonly canonicalIntent: EnginePostIntent["canonicalIntent"];
}

function prepareIntent(
  runtime: EngineRuntime,
  input: EngineSendInput,
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
      completion: Deferred.Deferred<RecordHash, SendError>;
    }>
  | Readonly<{
      kind: "waiting";
      barrier: Deferred.Deferred<undefined>;
    }>;

function activateIntent(
  runtime: EngineRuntime,
  prepared: PreparedSend,
): Effect.Effect<Deferred.Deferred<RecordHash, SendError>, SendError> {
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
    const barrier = pendingRecoveryFence(runtime, intent.conversationId);
    if (barrier !== undefined) {
      return { kind: "waiting", barrier } satisfies IntentActivation;
    }
    yield* bindPreparedIntent(runtime, prepared);
    const retained = runtime.intents.get(intent.postId);
    if (retained !== undefined) {
      const completedRecordHash = runtime.completedPosts.get(intent.postId);
      if (completedRecordHash !== undefined) {
        yield* Deferred.succeed(retained.completion, completedRecordHash);
      } else {
        yield* proposeIntent(runtime, retained);
      }
      return {
        kind: "ready",
        completion: retained.completion,
      } satisfies IntentActivation;
    }
    const completion = yield* Deferred.make<RecordHash, SendError>();
    const localIntent: EnginePostIntent = {
      intent,
      canonicalIntent,
      completion,
    };
    const completedRecordHash = runtime.completedPosts.get(intent.postId);
    if (completedRecordHash !== undefined) {
      yield* Effect.sync(() => {
        runtime.intents.set(intent.postId, localIntent);
      });
      yield* Deferred.succeed(completion, completedRecordHash);
    } else {
      yield* Effect.sync(() => {
        runtime.intents.set(intent.postId, localIntent);
      });
      yield* proposeIntent(runtime, localIntent);
    }
    return { kind: "ready", completion } satisfies IntentActivation;
  });
}
