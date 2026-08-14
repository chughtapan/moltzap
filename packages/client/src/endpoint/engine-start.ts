/** @file Deterministic START construction and peer-resolution transitions. */

import {
  AgentCard,
  type AgentId,
  type AgentName,
  MOLTZAP_VERSION,
  SignedMessage,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { Effect, Queue, Schema } from "effect";
import type { StartInput } from "../contract.js";
import {
  type ActionCertificate,
  type ActionCertifiedRecord,
  ClientRepresentationError,
  compareAgentIds,
  Content,
  decodeCanonical,
  type DirectPacket,
  encodeCanonical,
  type GenesisAnchor,
  hashActionCertificate,
  hashActionCertifiedRecord,
  hashAnchor,
  makeActionBinding,
  type Membership,
  type RecordHash,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  type StartAction,
  type StartProposal,
  verifyMembership,
  type VerifiedMembership,
} from "./representation.js";
import {
  type EngineActionFold,
  type EngineConversation,
  type EngineRuntime,
  EngineStartError,
} from "./engine-types.js";

const EncodedAgentCard = Schema.encodedSchema(AgentCard);

const StartIntentValue = Schema.Struct({
  moltzapVersion: Schema.Literal(MOLTZAP_VERSION),
  kind: Schema.Literal("start_intent"),
  peers: Schema.NonEmptyArray(EncodedAgentCard),
  content: Content,
});

export type CanonicalStartIntent = typeof StartIntentValue.Type;

export interface ResolvedStart {
  readonly membership: VerifiedMembership;
  readonly canonicalIntent: Uint8Array;
}

export interface AssembledStartRecord {
  readonly record: ActionCertifiedRecord;
  readonly recordHash: RecordHash;
}

/** Decode one exact durable START intent during endpoint recovery. */
export const decodeStartIntent = (
  bytes: Uint8Array,
): Effect.Effect<CanonicalStartIntent, ClientRepresentationError> =>
  decodeCanonical(StartIntentValue, bytes);

/** Canonically bind the other fixed members and initial content at this endpoint. */
export const canonicalStartIntent = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  content: StartAction["content"],
): Effect.Effect<Uint8Array, ClientRepresentationError> =>
  Effect.gen(function* () {
    const peers = membership.members
      .filter(
        (member) => member.agentId !== runtime.input.localAgentCard.agentId,
      )
      .sort((left, right) => compareAgentIds(left.agentId, right.agentId));
    const encoded = yield* Effect.forEach(
      peers,
      (card) => Schema.encode(AgentCard)(card),
      { concurrency: 1 },
    ).pipe(Effect.mapError(() => new ClientRepresentationError()));
    const first = encoded[0];
    if (first === undefined) {
      return yield* Effect.fail(new ClientRepresentationError());
    }
    return yield* encodeCanonical(StartIntentValue, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "start_intent",
      peers: [first, ...encoded.slice(1)],
      content,
    });
  });

const membershipFailure = (): EngineStartError =>
  new EngineStartError({ reason: "membership" });

const representationFailure = (): EngineStartError =>
  new EngineStartError({ reason: "representation" });

const reanchorFailure = (): EngineStartError =>
  new EngineStartError({ reason: "reanchor" });

const resolvePeer = (
  runtime: EngineRuntime,
  agentName: AgentName,
): Effect.Effect<VerifiedAgentCard, EngineStartError> =>
  runtime.input.registry.lookup({ agentName }).pipe(
    Effect.mapError(membershipFailure),
    Effect.flatMap((result) =>
      result.kind === "found"
        ? Effect.succeed(result.agentCard)
        : Effect.fail(membershipFailure()),
    ),
  );

const encodeAgentCards = (
  cards: readonly VerifiedAgentCard[],
): Effect.Effect<readonly (typeof EncodedAgentCard.Type)[], EngineStartError> =>
  Effect.forEach(cards, (card) => Schema.encode(AgentCard)(card), {
    concurrency: 1,
  }).pipe(Effect.mapError(representationFailure));

const sortedMembers = (
  local: VerifiedAgentCard,
  peers: readonly VerifiedAgentCard[],
):
  | readonly [VerifiedAgentCard, VerifiedAgentCard, ...VerifiedAgentCard[]]
  | undefined => {
  const members = [local, ...peers].sort((left, right) =>
    compareAgentIds(left.agentId, right.agentId),
  );
  const first = members[0];
  const second = members[1];
  return first === undefined || second === undefined
    ? undefined
    : [first, second, ...members.slice(2)];
};

/** Resolve, deduplicate, sort, verify, and canonically bind one START input. */
export const resolveStart = (
  runtime: EngineRuntime,
  input: StartInput,
): Effect.Effect<ResolvedStart, EngineStartError> =>
  Effect.gen(function* () {
    const peers = yield* Effect.forEach(
      input.peers,
      (peer) => resolvePeer(runtime, peer),
      { concurrency: "inherit" },
    );
    const identities = new Set<AgentId>(peers.map((card) => card.agentId));
    if (
      identities.size !== peers.length ||
      identities.has(runtime.input.localAgentCard.agentId) ||
      peers.length + 1 > 32
    ) {
      return yield* Effect.fail(membershipFailure());
    }
    const members = sortedMembers(runtime.input.localAgentCard, peers);
    if (members === undefined) {
      return yield* Effect.fail(membershipFailure());
    }
    const encodedMembers = yield* encodeAgentCards(members);
    const firstMember = encodedMembers[0];
    const secondMember = encodedMembers[1];
    if (firstMember === undefined || secondMember === undefined) {
      return yield* Effect.fail(membershipFailure());
    }
    const membershipValue: Membership = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "membership",
      conversationId: input.conversationId,
      membershipEpoch: 0,
      members: [firstMember, secondMember, ...encodedMembers.slice(2)],
    };
    const membership = yield* verifyMembership(
      membershipValue,
      runtime.input.registrySignerPublicKey,
    ).pipe(Effect.mapError(membershipFailure));

    const orderedPeers = [...peers].sort((left, right) =>
      compareAgentIds(left.agentId, right.agentId),
    );
    const encodedPeers = yield* encodeAgentCards(orderedPeers);
    const firstPeer = encodedPeers[0];
    if (firstPeer === undefined) {
      return yield* Effect.fail(membershipFailure());
    }
    const canonicalIntent = yield* encodeCanonical(StartIntentValue, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "start_intent",
      peers: [firstPeer, ...encodedPeers.slice(1)],
      content: input.content,
    }).pipe(Effect.mapError(representationFailure));
    return { membership, canonicalIntent };
  });

/** Construct a genesis proposal from the worker's current Router anchor. */
export const constructLocalStart = (
  runtime: EngineRuntime,
  input: StartInput,
  resolved: ResolvedStart,
): Effect.Effect<
  {
    readonly conversation: EngineConversation;
    readonly proposal: StartProposal;
  },
  EngineStartError
> =>
  Effect.gen(function* () {
    const routerAnchor = yield* runtime.input.routerWorker.currentAnchor.pipe(
      Effect.mapError(reanchorFailure),
    );
    const genesisAnchor: GenesisAnchor = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "genesis_anchor",
      conversationId: input.conversationId,
      membershipHash: resolved.membership.hash,
      routerInstanceId: routerAnchor.routerInstanceId,
    };
    const anchorHash = yield* hashAnchor(genesisAnchor).pipe(
      Effect.mapError(representationFailure),
    );
    const action: StartAction = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "start_action",
      conversationId: input.conversationId,
      membershipHash: resolved.membership.hash,
      anchorHash,
      previousRecordHash: null,
      beginDigest: null,
      actionId: "START",
      authorAgentId: runtime.input.localAgentCard.agentId,
      content: input.content,
      replyFingerprint: null,
    };
    const conversation: EngineConversation = {
      foldKind: "start",
      conversationId: input.conversationId,
      canonicalIntent: resolved.canonicalIntent,
      membership: resolved.membership,
      genesisAnchor,
      currentAnchor: genesisAnchor,
      action,
      actionSignatures: new Map(),
      durabilityVotes: new Map(),
      actionSignatureQueued: false,
      durabilityVoteQueued: false,
      certifiedBroadcastQueued: false,
    };
    return {
      conversation,
      proposal: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "start_proposal",
        membership: resolved.membership.membership,
        genesisAnchor,
        action,
      },
    };
  });

/** Sign one deterministic self-addressed action-signature statement. */
export const signLocalAction = (
  runtime: EngineRuntime,
  conversation: EngineConversation,
) =>
  makeActionBinding(conversation.action).pipe(
    Effect.flatMap((action) =>
      signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "action_signature",
          signerAgentId: runtime.input.localAgentCard.agentId,
          action,
        },
        agentCard: runtime.input.localAgentCard,
        signingAuthority: runtime.input.signingAuthority,
      }),
    ),
  );

/** Build the unanimous action certificate and its stable record identity. */
export const assembleActionCertifiedRecord = (
  conversation: EngineActionFold,
): Effect.Effect<AssembledStartRecord, ClientRepresentationError> =>
  Effect.gen(function* () {
    const action = yield* makeActionBinding(conversation.action);
    const signed = [...conversation.actionSignatures.values()].sort(
      (left, right) => compareAgentIds(left.senderAgentId, right.senderAgentId),
    );
    const encoded = yield* Effect.forEach(
      signed,
      (message) => Schema.encode(SignedMessage)(message),
      { concurrency: 1 },
    ).pipe(Effect.mapError(() => new ClientRepresentationError()));
    const first = encoded[0];
    if (first === undefined) {
      return yield* Effect.fail(new ClientRepresentationError());
    }
    const certificate: ActionCertificate = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certificate",
      action,
      signatures: [first, ...encoded.slice(1)],
    };
    const record: ActionCertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certified_record",
      membership: conversation.membership.membership,
      anchorHash: conversation.action.anchorHash,
      action: conversation.action,
      actionHash: yield* hashActionCertificate(certificate),
      actionCertificate: certificate,
    };
    return { record, recordHash: yield* hashActionCertifiedRecord(record) };
  });

/** Queue a signed direct packet without bypassing Router ingress. */
export const queueOuterPacket = (
  runtime: EngineRuntime,
  conversation: Pick<EngineActionFold, "membership">,
  packet: DirectPacket,
) =>
  signOuterPacket({
    packet,
    membership: conversation.membership,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.tap((message) =>
      Effect.sync(() => runtime.outbound.push(message)).pipe(
        Effect.zipRight(Queue.offer(runtime.outboundSignal, undefined)),
      ),
    ),
    Effect.asVoid,
  );

/** Queue signed stable evidence without applying it locally. */
export const queueOuterEvidence = (
  runtime: EngineRuntime,
  conversation: Pick<EngineActionFold, "membership">,
  evidence: SignedMessage,
) =>
  signOuterEvidence({
    evidence,
    membership: conversation.membership,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.tap((message) =>
      Effect.sync(() => runtime.outbound.push(message)).pipe(
        Effect.zipRight(Queue.offer(runtime.outboundSignal, undefined)),
      ),
    ),
    Effect.asVoid,
  );
