/** @file Address resolution, immutable intent binding, and proposal creation. */

import { AgentCard, MOLTZAP_VERSION } from "@moltzap/identity";
import { Deferred, Duration, Effect, Schedule, Schema } from "effect";
import type { FirewallSendError } from "../../firewall/runtime.js";
import type {
  ConversationFoundation,
  EndpointStoreError,
  FirewallCompletion,
  PostIntentBinding,
  PostIntent as StoredPostIntent,
} from "../../store/index.js";
import type { RouterWorkerUnavailableError } from "../router/index.js";
import type { MessageAddressInput } from "../wire/values.js";
import type {
  EngineConversation,
  EngineOutboxError,
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
import { anchorHashAtHead } from "./history/index.js";
import {
  catchUpRetrySchedule,
  pendingRecoveryFence,
} from "./recovery/index.js";

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

/**
 * Fail a send whose intent bind did not complete. A store refusal is raised
 * before the bind commits and rolls it back, so nothing was queued. A raw
 * persistence failure may come from the commit itself, so whether the intent
 * is durable is unknown; it is reported as a storage fault, since a durable
 * intent outside `runtime.intents` waits for a restart.
 * @param runtime The engine whose daemon hears of the fault.
 * @param error The store's failure.
 * @returns The send's failure.
 */
function failBind(
  runtime: EngineRuntime,
  error: EndpointStoreError,
): Effect.Effect<never, SendError> {
  return error.reason === "persistence"
    ? runtime.input.reportStorageFault.pipe(
        Effect.zipRight(
          Effect.fail(new SendError({ reason: "outcome-unknown" })),
        ),
      )
    : Effect.fail(storeFailure(error));
}

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
        anchorHash: anchorHashAtHead(conversation, head),
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

/**
 * A proposal's resends: the catch-up retry delays, until a resend finds none
 * due.
 */
const proposalResendSchedule = catchUpRetrySchedule.pipe(
  Schedule.whileInput((due: boolean) => due),
);

/**
 * Queue a proposal behind the certified record it extends, then resend both
 * while members' action signatures are missing. A store failure while
 * queueing is reported as a storage fault: the intent stays bound but not
 * proposed until recovery after a restart proposes it. Activation proposes
 * inside an uninterruptible region and a forked fiber inherits it, so the
 * resends run interruptibly and end with the engine.
 * @param runtime Engine that sends the proposal.
 * @param proposal Authorized proposal and the intent it proposes.
 * @returns Completion once both envelopes are queued, the intent records the
 *     proposed action, and its resends are scheduled.
 */
function queueAuthorizedProposal(
  runtime: EngineRuntime,
  proposal: AuthorizedProposal,
): Effect.Effect<void, SendError> {
  return Effect.gen(function* () {
    yield* authorizeAction(runtime, proposal);
    yield* Effect.uninterruptible(
      queueProposal(runtime, proposal).pipe(
        Effect.catchTags({
          EndpointStoreError: (error) =>
            runtime.input.reportStorageFault.pipe(
              Effect.zipRight(Effect.fail(storeFailure(error))),
            ),
          ClientRepresentationError: () => Effect.fail(representationFailure()),
        }),
        Effect.zipRight(
          Effect.sync(() => {
            proposal.localIntent.proposedActionHash = proposal.actionHash;
          }),
        ),
      ),
    );
    yield* Effect.scheduleFrom(
      resendProposal(runtime, proposal),
      true,
      proposalResendSchedule,
    ).pipe(Effect.interruptible, Effect.forkIn(runtime.scope));
  });
}

/**
 * Queue a proposal and, for a POST, the certified record of the head it
 * extends ahead of it. A faulty member can seal its durability vote so that
 * only some members open it, so a member may not have certified the head the
 * proposer certified when the proposal arrives, and it would drop the
 * proposal as not gap-free. The proposer's own copy of that record, which
 * every member can open, reaches each member first.
 * @param runtime Engine that sends the proposal.
 * @param proposal The proposal and the conversation it extends.
 * @returns Completion once both envelopes are queued.
 */
function queueProposal(
  runtime: EngineRuntime,
  proposal: AuthorizedProposal,
): Effect.Effect<void, EngineOutboxError> {
  const head = proposal.conversation.head;
  const queueHead =
    head === undefined
      ? Effect.void
      : runtime.outbox.queuePacket(proposal.conversation, head.record);
  return queueHead.pipe(
    Effect.zipRight(
      runtime.outbox.queuePacket(proposal.conversation, {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_proposal",
        action: proposal.action,
      }),
    ),
  );
}

/**
 * Send a proposal again, with its head, while it is still the intent's
 * proposal at the conversation's head and its action certificate is
 * incomplete. Members that dropped it, such as one still catching up while
 * fenced, sign the new copy; members that signed already deduplicate it by
 * `ActionHash`. A fenced conversation sends nothing, and its resends wait for
 * it to recover. A store failure ends the resends.
 * @param runtime Engine that sends the proposal.
 * @param proposal The proposal, the conversation it extends, and its intent.
 * @returns Whether a later resend is still due.
 */
function resendProposal(
  runtime: EngineRuntime,
  proposal: AuthorizedProposal,
): Effect.Effect<boolean> {
  const { action } = proposal;
  return runtime.gate.withPermits(1)(
    Effect.suspend(() => {
      const conversation = runtime.conversations.get(action.conversationId);
      if (
        conversation === undefined ||
        !proposalIsOpen(runtime, proposal, conversation)
      ) {
        return Effect.succeed(false);
      }
      if (runtime.phases.isRecovering(runtime, action.conversationId)) {
        return Effect.succeed(true);
      }
      return Effect.uninterruptible(
        queueProposal(runtime, { ...proposal, conversation }),
      ).pipe(
        Effect.as(true),
        Effect.catchAll(() =>
          Effect.logWarning(
            "Proposal resends stopped: its envelopes could not be queued",
          ).pipe(Effect.as(false)),
        ),
      );
    }),
  );
}

/**
 * Whether a proposal still awaits its action certificate: it is still its
 * intent's proposal, its post has not completed, no record certifies it, and
 * the conversation's head is still the one it extends.
 * @param runtime Engine that sent the proposal.
 * @param proposal The proposal and the intent it proposes.
 * @param conversation The conversation's current state.
 * @returns Whether a resend of the proposal is still useful.
 */
function proposalIsOpen(
  runtime: EngineRuntime,
  proposal: AuthorizedProposal,
  conversation: EngineConversation,
): boolean {
  const { action, actionHash, localIntent } = proposal;
  const head = conversation.head?.recordHash ?? null;
  return (
    localIntent.proposedActionHash === actionHash &&
    !runtime.completedPosts.has(action.postIntent.postId) &&
    runtime.actionFolds.get(actionHash)?.recordHash === undefined &&
    head === action.previousRecordHash
  );
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
      activateIntent(runtime, prepared, (binding) =>
        runtime.input.store
          .bindPostIntent(binding)
          .pipe(Effect.as("admitted" as const)),
      ).pipe(
        Effect.flatMap((activation) =>
          activation.kind === "refused"
            ? Effect.fail(representationFailure())
            : Effect.succeed({
                postId: prepared.intent.postId,
                completion: activation.completion,
              }),
        ),
      ),
    ),
    Effect.withSpan("prepareSend"),
  );

/** Prepared data has no execution authority until the atomic store transition succeeds. */
export interface PreparedSend {
  readonly membership: VerifiedMembership;
  readonly intent: PostIntent;
  readonly canonicalIntent: EnginePostIntent["canonicalIntent"];
}

/** The application boundary supplies checking without gaining engine capabilities. */
export type PreparedSendCheck = (
  prepared: PreparedSend,
  terminal: boolean,
) => Effect.Effect<
  {
    readonly completion: FirewallCompletion;
    readonly refusal: FirewallSendError;
  },
  EndpointStoreError
>;

/** One recheck bounds stale policy decisions; terminal shadow observations carry no advice. */
export const prepareCheckedSend = (
  runtime: EngineRuntime,
  input: EngineSendInput,
  check: PreparedSendCheck,
): Effect.Effect<PreparedSendHandle, SendError | FirewallSendError> =>
  Effect.gen(function* () {
    yield* awaitRouterAttachment(runtime);
    const prepared = yield* prepareIntent(runtime, input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const terminal = attempt === 2;
      const checked = yield* check(prepared, terminal).pipe(
        Effect.mapError(storeFailure),
      );
      const activation = yield* activateIntent(runtime, prepared, (binding) =>
        runtime.input.store.bindCheckedPostIntent(binding, checked.completion),
      );
      if (activation.kind === "ready") {
        return {
          postId: prepared.intent.postId,
          completion: activation.completion,
        };
      }
      if (activation.disposition === "withheld") {
        return yield* checked.refusal;
      }
    }
    return yield* Effect.fail(representationFailure());
  }).pipe(Effect.withSpan("prepareCheckedSend"));

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
  bind: IntentAdmission,
): Effect.Effect<"admitted" | "withheld" | "stale", SendError> {
  return Effect.gen(function* () {
    const retained = runtime.conversations.get(prepared.intent.conversationId);
    if (retained !== undefined) {
      if (retained.membership.hash !== prepared.membership.hash) {
        return yield* Effect.fail(
          new SendError({ reason: "certification-unavailable" }),
        );
      }
      return yield* bind({
        kind: "existing-conversation",
        intent: storedIntent(prepared),
      }).pipe(
        Effect.catchTag("EndpointStoreError", (error) =>
          failBind(runtime, error),
        ),
      );
    }
    const created = yield* createConversation(runtime, prepared.membership);
    const disposition = yield* bind({
      kind: "new-conversation",
      foundation: created.foundation,
      intent: storedIntent(prepared),
    }).pipe(
      Effect.catchTag("EndpointStoreError", (error) =>
        failBind(runtime, error),
      ),
    );
    if (disposition !== "admitted") {
      return disposition;
    }
    yield* Effect.sync(() => {
      runtime.conversations.set(
        created.conversation.conversationId,
        created.conversation,
      );
    });
    return disposition;
  });
}

type IntentAdmission = (
  binding: PostIntentBinding,
) => Effect.Effect<"admitted" | "withheld" | "stale", EndpointStoreError>;

type IntentActivation =
  | Readonly<{ kind: "refused"; disposition: "withheld" | "stale" }>
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
  bind: IntentAdmission,
): Effect.Effect<Exclude<IntentActivation, { kind: "waiting" }>, SendError> {
  return runtime.gate
    .withPermits(1)(
      Effect.uninterruptible(activateIntentOnce(runtime, prepared, bind)),
    )
    .pipe(
      Effect.flatMap((activation) => {
        switch (activation.kind) {
          case "ready":
          case "refused":
            return Effect.succeed(activation);
          case "waiting":
            return runtime.phases
              .rearmCatchUp(runtime, prepared.intent.conversationId)
              .pipe(
                Effect.zipRight(Deferred.await(activation.barrier)),
                Effect.zipRight(activateIntent(runtime, prepared, bind)),
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
  bind: IntentAdmission,
): Effect.Effect<IntentActivation, SendError> {
  const { intent } = prepared;
  return Effect.gen(function* () {
    const barrier = pendingRecoveryFence(runtime, intent.conversationId);
    if (barrier !== undefined) {
      return { kind: "waiting", barrier } satisfies IntentActivation;
    }
    const disposition = yield* bindPreparedIntent(runtime, prepared, bind);
    if (disposition !== "admitted") {
      return { kind: "refused", disposition } satisfies IntentActivation;
    }
    return yield* activateBoundIntent(runtime, prepared);
  });
}

/**
 * Propose a post whose intent `bindPreparedIntent` durably stored, or complete
 * it when it already certified. The intent is in the store and
 * `runtime.intents` before any proposal, so a failure here does not mean the
 * post was not sent: `rebasePendingIntents` proposes it again when the
 * conversation's head moves, and recovery proposes it after a restart. So
 * every failure here fails the send as `delivery-pending`.
 * @param runtime Engine whose conversation and outbox take the proposal.
 * @param prepared The stored intent with its canonical bytes.
 * @returns The ready activation and its completion latch.
 */
function activateBoundIntent(
  runtime: EngineRuntime,
  prepared: PreparedSend,
): Effect.Effect<IntentActivation, SendError> {
  const { canonicalIntent, intent } = prepared;
  return Effect.gen(function* () {
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
  }).pipe(
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- A bound intent is proposed again later, so every failure here is delivery-pending, as this function's JSDoc explains.
    Effect.mapError(() => new SendError({ reason: "delivery-pending" })),
  );
}
