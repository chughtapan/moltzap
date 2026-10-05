/** @file Restart catch-up and threshold re-anchor tests for the addressed engine. */

import type { RegistryLookupResult } from "@moltzap/identity/registry";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  AgentCard,
  type AgentSigningAuthority,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
  SignedMessage,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { RouterInstanceId } from "@moltzap/router";
import {
  Chunk,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Schema,
} from "effect";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AddressRegistryPort } from "../address.js";
import {
  identifier,
  issueTestCard,
  makeTestAuthority,
  type RegistryKeyPair,
} from "../../../__tests__/agent-card-fixtures.js";
import { forwardStoredOutbound } from "../../../__tests__/forward-stored-outbound.js";
import { pollCursor as fixturePollCursor } from "../../../__tests__/router-worker-fixtures.js";
import { type EndpointStore, openEndpointStore } from "../../../store/index.js";
import {
  type RouterDiscontinuityReason,
  type RouterIngressDisposition,
  RouterWorkerDiscontinuityError,
  type RouterWorkerIngress,
  type RouterWorkerRecovery,
} from "../../router/index.js";
import {
  type ActionCertifiedRecord as ActionCertifiedRecordValue,
  type ActionCore,
  type ActionProposal,
  type CatchUpIncomplete,
  type CatchUpPage,
  type CatchUpRequest,
  type CertifiedRecord,
  compareAgentIds,
  Content,
  decodeCanonical,
  type DecodedOuterBody,
  decodeOuterBody,
  deriveConversationId,
  type DirectPacket,
  encodeCanonical,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  GenesisAnchorBody,
  hashAction,
  hashAnchor,
  hashPostIntent,
  hashRecord,
  MembershipDescriptor,
  mintPostId,
  type PostIntent,
  type ReanchorBody,
  type RecordCore,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  type VerifiedMembership,
  verifyMembershipDescriptor,
} from "../../wire/index.js";
import { MessageAddressInput } from "../../wire/values.js";
import {
  type EndpointEngine,
  type EndpointEngineInput,
  EngineOutboundError,
  makeEndpointEngine,
} from "../index.js";

/* eslint-disable max-lines, max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- One exact cryptographic trace keeps protocol order and assertions together. */

/** The Router-worker operations an engine consumes. */
type EngineRouterPort = EndpointEngineInput["routerWorker"];

interface IdentityFixture {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthority;
}

interface RecoveryFixture {
  readonly engine: EndpointEngine;
  readonly input: EndpointEngineInput;
  readonly store: EndpointStore;
  readonly local: IdentityFixture;
  readonly remote: IdentityFixture;
  readonly registryKeys: RegistryKeyPair;
  readonly registrySignerPublicKey: typeof Ed25519PublicKey.Type;
  readonly membership: VerifiedMembership;
  readonly certifiedRecord: CertifiedRecord;
  readonly normalOutbound: Queue.Queue<SignedMessage>;
}

interface N4Foundation {
  readonly engine: EndpointEngine;
  readonly membership: VerifiedMembership;
  readonly third: IdentityFixture;
  readonly fourth: IdentityFixture;
}

interface N4PartialHistory {
  readonly certifiedHead: CertifiedRecord;
  readonly stagedSuccessor: ActionCertifiedRecordValue;
  readonly certifiedSuccessor: CertifiedRecord;
}

interface FixtureRouterContext {
  readonly store: EndpointStore;
  readonly normalOutbound: Queue.Queue<SignedMessage>;
}

interface QueuedActionProposal {
  readonly message: SignedMessage;
  readonly proposal: ActionProposal;
}

interface HeldRouterInput {
  readonly holdOutbound: Ref.Ref<boolean>;
  readonly pendingOutboundIds: Queue.Queue<string>;
}

type ReanchorVote = Extract<
  EvidenceStatementValue,
  { readonly kind: "reanchor_vote" }
>;

const actionSignatureKind: EvidenceStatementValue["kind"] = "action_signature";
const acceptedDisposition: RouterIngressDisposition = "accepted";
const ignoredDisposition: RouterIngressDisposition = "ignored";
const durabilityVoteKind: EvidenceStatementValue["kind"] = "durability_vote";

const oldRouterInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 8),
);
const newRouterInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 9),
);
const pollCursor = fixturePollCursor(1);

function makeHeldRouter(input: HeldRouterInput) {
  return (context: FixtureRouterContext): EngineRouterPort => ({
    currentAnchor: Effect.succeed({
      routerInstanceId: oldRouterInstanceId,
      pollCursor,
    }),
    awaitAnchor: Effect.succeed({
      routerInstanceId: oldRouterInstanceId,
      pollCursor,
    }),
    send: (outboundId) =>
      Ref.get(input.holdOutbound).pipe(
        Effect.flatMap((hold) =>
          hold
            ? Queue.offer(input.pendingOutboundIds, outboundId).pipe(
                Effect.asVoid,
              )
            : forwardStoredOutbound(
                context.store,
                context.normalOutbound,
                outboundId,
              ),
        ),
      ),
  });
}

const encodedEvidence = (
  identity: IdentityFixture,
  statement: EvidenceStatementValue,
) =>
  signEvidenceMessage({
    statement,
    agentCard: identity.card,
    signingAuthority: identity.authority,
  }).pipe(Effect.flatMap((message) => Schema.encode(SignedMessage)(message)));

const buildCertifiedGenesis = (
  local: IdentityFixture,
  remote: IdentityFixture,
  membership: VerifiedMembership,
  routerInstanceId: typeof RouterInstanceId.Type = oldRouterInstanceId,
): Effect.Effect<CertifiedRecord> =>
  Effect.gen(function* () {
    const postIntent: PostIntent = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "post_intent",
      conversationId: membership.descriptor.conversationId,
      membershipHash: membership.hash,
      authorAgentId: remote.card.agentId,
      postId: yield* mintPostId(),
      content: [{ type: "text", text: "certified before restart" }],
    };
    const anchor: GenesisAnchorBody = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "genesis_anchor_body",
      conversationId: membership.descriptor.conversationId,
      membershipHash: membership.hash,
      routerInstanceId,
    };
    const action: ActionCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "GENESIS",
      conversationId: membership.descriptor.conversationId,
      membership: membership.descriptor,
      anchor,
      previousRecordHash: null,
      postIntent,
      postIntentHash: yield* hashPostIntent(postIntent),
    };
    const actionHash = yield* hashAction(action);
    const signAction = (identity: IdentityFixture) =>
      signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "action_signature",
          signerAgentId: identity.card.agentId,
          actionHash,
        },
        agentCard: identity.card,
        signingAuthority: identity.authority,
      }).pipe(
        Effect.flatMap((message) => Schema.encode(SignedMessage)(message)),
      );
    const localActionEvidence = yield* signAction(local);
    const remoteActionEvidence = yield* signAction(remote);
    const anchorHash = yield* hashAnchor(anchor);
    const recordCore: RecordCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "record_core",
      membership: membership.descriptor,
      anchorHash,
      action,
      actionHash,
    };
    const recordHash = yield* hashRecord(recordCore);
    const signDurability = (identity: IdentityFixture) =>
      signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "durability_vote",
          signerAgentId: identity.card.agentId,
          conversationId: membership.descriptor.conversationId,
          membershipHash: membership.hash,
          recordHash,
        },
        agentCard: identity.card,
        signingAuthority: identity.authority,
      }).pipe(
        Effect.flatMap((message) => Schema.encode(SignedMessage)(message)),
      );
    const localDurabilityEvidence = yield* signDurability(local);
    const remoteDurabilityEvidence = yield* signDurability(remote);
    const certifiedRecord: CertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "certified_record",
      actionCertifiedRecord: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_certified_record",
        recordHash,
        recordCore,
        routerAnchor: anchor,
        actionCertificate: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "action_certificate",
          actionHash,
          signatures: [localActionEvidence, remoteActionEvidence],
        },
      },
      durabilityCertificate: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "durability_certificate",
        recordHash,
        votes: [localDurabilityEvidence, remoteDurabilityEvidence],
      },
    };
    return certifiedRecord;
  }).pipe(Effect.orDie);

const makeFixtureWithRouter = (
  makeRouter: (context: FixtureRouterContext) => EngineRouterPort,
  identityBytes: { readonly local: number; readonly remote: number } = {
    local: 1,
    remote: 2,
  },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const registryKeys = generateKeyPairSync("ed25519");
    const registrySignerPublicKey = yield* Schema.decodeUnknown(
      Ed25519PublicKey,
    )(registryKeys.publicKey.export({ format: "jwk" }));
    const localAuthority = yield* makeTestAuthority();
    const remoteAuthority = yield* makeTestAuthority();
    const local: IdentityFixture = {
      card: yield* issueTestCard({
        byte: identityBytes.local,
        name: `recovery-${identityBytes.local}`,
        authority: localAuthority,
        registryKeys,
      }),
      authority: localAuthority,
    };
    const remote: IdentityFixture = {
      card: yield* issueTestCard({
        byte: identityBytes.remote,
        name: `recovery-${identityBytes.remote}`,
        authority: remoteAuthority,
        registryKeys,
      }),
      authority: remoteAuthority,
    };
    const localCard = yield* Schema.encode(AgentCard)(local.card);
    const remoteCard = yield* Schema.encode(AgentCard)(remote.card);
    const conversationId = yield* deriveConversationId([
      local.card.agentId,
      remote.card.agentId,
    ]);
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "membership_descriptor",
      conversationId,
      members: [localCard, remoteCard],
    });
    const membership = yield* verifyMembershipDescriptor(
      descriptor,
      registrySignerPublicKey,
    );
    const certifiedRecord = yield* buildCertifiedGenesis(
      local,
      remote,
      membership,
    );
    const anchor = certifiedRecord.actionCertifiedRecord.routerAnchor;
    if (anchor.kind !== "genesis_anchor_body") {
      return yield* Effect.dieMessage("genesis fixture lost its anchor");
    }
    const store = yield* openEndpointStore(
      yield* fileSystem.makeTempDirectoryScoped({
        prefix: "moltzap-recovery-",
      }),
    );
    yield* store.putConversationFoundation({
      conversationId,
      membershipHash: membership.hash,
      canonicalMembership: yield* encodeCanonical(
        MembershipDescriptor,
        membership.descriptor,
      ),
      anchorHash: yield* hashAnchor(anchor),
      canonicalAnchor: yield* encodeCanonical(GenesisAnchorBody, anchor),
    });
    const cards: readonly [VerifiedAgentCard, VerifiedAgentCard] = [
      local.card,
      remote.card,
    ];
    const registry: AddressRegistryPort = {
      lookup: (request) => {
        const card = cards.find((candidate) =>
          "agentId" in request
            ? candidate.agentId === request.agentId
            : candidate.agentName === request.agentName,
        );
        const result: RegistryLookupResult =
          card === undefined
            ? { kind: "not_found" }
            : { kind: "found", agentCard: card };
        return Effect.succeed(result);
      },
    };
    const normalOutbound = yield* Queue.unbounded<SignedMessage>();
    const input = {
      localAgentCard: local.card,
      signingAuthority: local.authority,
      registrySignerPublicKey,
      registry,
      store,
      actionPolicy: () => Effect.succeed("sign"),
      routerWorker: makeRouter({ store, normalOutbound }),
    } satisfies EndpointEngineInput;
    const engine = yield* makeEndpointEngine(input).pipe(Effect.orDie);
    return {
      engine,
      input,
      store,
      local,
      remote,
      registryKeys,
      registrySignerPublicKey,
      membership,
      certifiedRecord,
      normalOutbound,
    } satisfies RecoveryFixture;
  }).pipe(Effect.provide(NodeFileSystem.layer));

const makeFixtureRouter = ({
  store,
  normalOutbound,
}: FixtureRouterContext): EngineRouterPort => ({
  currentAnchor: Effect.succeed({
    routerInstanceId: newRouterInstanceId,
    pollCursor,
  }),
  awaitAnchor: Effect.succeed({
    routerInstanceId: newRouterInstanceId,
    pollCursor,
  }),
  send: (outboundId) =>
    forwardStoredOutbound(store, normalOutbound, outboundId),
});

const makeFixture = makeFixtureWithRouter(makeFixtureRouter);
const makeNonLexicalAgentOrderFixture = makeFixtureWithRouter(
  makeFixtureRouter,
  { local: 0, remote: 208 },
);

const addN4Foundation = (
  fixture: RecoveryFixture,
  genesisRouterInstanceId: typeof RouterInstanceId.Type = oldRouterInstanceId,
) =>
  Effect.gen(function* () {
    const thirdAuthority = yield* makeTestAuthority();
    const fourthAuthority = yield* makeTestAuthority();
    const third: IdentityFixture = {
      card: yield* issueTestCard({
        byte: 3,
        name: "recovery-3",
        authority: thirdAuthority,
        registryKeys: fixture.registryKeys,
      }),
      authority: thirdAuthority,
    };
    const fourth: IdentityFixture = {
      card: yield* issueTestCard({
        byte: 4,
        name: "recovery-4",
        authority: fourthAuthority,
        registryKeys: fixture.registryKeys,
      }),
      authority: fourthAuthority,
    };
    const conversationId = yield* deriveConversationId([
      fixture.local.card.agentId,
      fixture.remote.card.agentId,
      third.card.agentId,
      fourth.card.agentId,
    ]);
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "membership_descriptor",
      conversationId,
      members: yield* Effect.forEach(
        [fixture.local, fixture.remote, third, fourth],
        (identity) => Schema.encode(AgentCard)(identity.card),
        { concurrency: 1 },
      ),
    });
    const membership = yield* verifyMembershipDescriptor(
      descriptor,
      fixture.registrySignerPublicKey,
    );
    const anchor: GenesisAnchorBody = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "genesis_anchor_body",
      conversationId,
      membershipHash: membership.hash,
      routerInstanceId: genesisRouterInstanceId,
    };
    yield* fixture.store.putConversationFoundation({
      conversationId,
      membershipHash: membership.hash,
      canonicalMembership: yield* encodeCanonical(
        MembershipDescriptor,
        membership.descriptor,
      ),
      anchorHash: yield* hashAnchor(anchor),
      canonicalAnchor: yield* encodeCanonical(GenesisAnchorBody, anchor),
    });
    const cards = [
      fixture.local.card,
      fixture.remote.card,
      third.card,
      fourth.card,
    ];
    const registry: AddressRegistryPort = {
      lookup: (request) => {
        const card = cards.find((candidate) =>
          "agentId" in request
            ? candidate.agentId === request.agentId
            : candidate.agentName === request.agentName,
        );
        const result: RegistryLookupResult =
          card === undefined
            ? { kind: "not_found" }
            : { kind: "found", agentCard: card };
        return Effect.succeed(result);
      },
    };
    const engine = yield* makeEndpointEngine({
      localAgentCard: fixture.local.card,
      signingAuthority: fixture.local.authority,
      registrySignerPublicKey: fixture.registrySignerPublicKey,
      registry,
      store: fixture.store,
      actionPolicy: () => Effect.succeed("sign"),
      routerWorker: {
        currentAnchor: Effect.succeed({
          routerInstanceId: newRouterInstanceId,
          pollCursor,
        }),
        awaitAnchor: Effect.succeed({
          routerInstanceId: newRouterInstanceId,
          pollCursor,
        }),
        send: (outboundId) =>
          forwardStoredOutbound(
            fixture.store,
            fixture.normalOutbound,
            outboundId,
          ),
      },
    }).pipe(Effect.orDie);
    return { engine, membership, third, fourth } satisfies N4Foundation;
  }).pipe(Effect.orDie);

const buildN4PartialHistory = (
  fixture: RecoveryFixture,
  n4: N4Foundation,
): Effect.Effect<N4PartialHistory> =>
  Effect.gen(function* () {
    const headIntent: PostIntent = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "post_intent",
      conversationId: n4.membership.descriptor.conversationId,
      membershipHash: n4.membership.hash,
      authorAgentId: fixture.remote.card.agentId,
      postId: yield* mintPostId(),
      content: [{ type: "text", text: "certified N4 head" }],
    };
    const headAnchor: GenesisAnchorBody = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "genesis_anchor_body",
      conversationId: n4.membership.descriptor.conversationId,
      membershipHash: n4.membership.hash,
      routerInstanceId: oldRouterInstanceId,
    };
    const headAction: ActionCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "GENESIS",
      conversationId: n4.membership.descriptor.conversationId,
      membership: n4.membership.descriptor,
      anchor: headAnchor,
      previousRecordHash: null,
      postIntent: headIntent,
      postIntentHash: yield* hashPostIntent(headIntent),
    };
    const headActionHash = yield* hashAction(headAction);
    const headLocalAction = yield* encodedEvidence(fixture.local, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_signature",
      signerAgentId: fixture.local.card.agentId,
      actionHash: headActionHash,
    });
    const headRemoteAction = yield* encodedEvidence(fixture.remote, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_signature",
      signerAgentId: fixture.remote.card.agentId,
      actionHash: headActionHash,
    });
    const headThirdAction = yield* encodedEvidence(n4.third, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_signature",
      signerAgentId: n4.third.card.agentId,
      actionHash: headActionHash,
    });
    const headFourthAction = yield* encodedEvidence(n4.fourth, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_signature",
      signerAgentId: n4.fourth.card.agentId,
      actionHash: headActionHash,
    });
    const headAnchorHash = yield* hashAnchor(headAnchor);
    const headCore: RecordCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "record_core",
      membership: n4.membership.descriptor,
      anchorHash: headAnchorHash,
      action: headAction,
      actionHash: headActionHash,
    };
    const headRecordHash = yield* hashRecord(headCore);
    const headLocalDurability = yield* encodedEvidence(fixture.local, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "durability_vote",
      signerAgentId: fixture.local.card.agentId,
      conversationId: n4.membership.descriptor.conversationId,
      membershipHash: n4.membership.hash,
      recordHash: headRecordHash,
    });
    const headRemoteDurability = yield* encodedEvidence(fixture.remote, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "durability_vote",
      signerAgentId: fixture.remote.card.agentId,
      conversationId: n4.membership.descriptor.conversationId,
      membershipHash: n4.membership.hash,
      recordHash: headRecordHash,
    });
    const headFourthDurability = yield* encodedEvidence(n4.fourth, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "durability_vote",
      signerAgentId: n4.fourth.card.agentId,
      conversationId: n4.membership.descriptor.conversationId,
      membershipHash: n4.membership.hash,
      recordHash: headRecordHash,
    });
    const certifiedHead: CertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "certified_record",
      actionCertifiedRecord: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_certified_record",
        recordHash: headRecordHash,
        recordCore: headCore,
        routerAnchor: headAnchor,
        actionCertificate: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "action_certificate",
          actionHash: headActionHash,
          signatures: [
            headLocalAction,
            headRemoteAction,
            headThirdAction,
            headFourthAction,
          ],
        },
      },
      durabilityCertificate: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "durability_certificate",
        recordHash: headRecordHash,
        votes: [
          headLocalDurability,
          headRemoteDurability,
          headFourthDurability,
        ],
      },
    };

    const successorIntent: PostIntent = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "post_intent",
      conversationId: n4.membership.descriptor.conversationId,
      membershipHash: n4.membership.hash,
      authorAgentId: n4.fourth.card.agentId,
      postId: yield* mintPostId(),
      content: [{ type: "text", text: "partially disseminated successor" }],
    };
    const successorAction: ActionCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "POST",
      conversationId: n4.membership.descriptor.conversationId,
      membershipHash: n4.membership.hash,
      anchorHash: headAnchorHash,
      previousRecordHash: headRecordHash,
      postIntent: successorIntent,
      postIntentHash: yield* hashPostIntent(successorIntent),
    };
    const successorActionHash = yield* hashAction(successorAction);
    const successorRemoteAction = yield* encodedEvidence(fixture.remote, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_signature",
      signerAgentId: fixture.remote.card.agentId,
      actionHash: successorActionHash,
    });
    const successorThirdAction = yield* encodedEvidence(n4.third, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_signature",
      signerAgentId: n4.third.card.agentId,
      actionHash: successorActionHash,
    });
    const successorFourthAction = yield* encodedEvidence(n4.fourth, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_signature",
      signerAgentId: n4.fourth.card.agentId,
      actionHash: successorActionHash,
    });
    const successorCore: RecordCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "record_core",
      membership: n4.membership.descriptor,
      anchorHash: headAnchorHash,
      action: successorAction,
      actionHash: successorActionHash,
    };
    const successorRecordHash = yield* hashRecord(successorCore);
    const stagedSuccessor: ActionCertifiedRecordValue = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certified_record",
      recordHash: successorRecordHash,
      recordCore: successorCore,
      routerAnchor: headAnchor,
      actionCertificate: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_certificate",
        actionHash: successorActionHash,
        signatures: [
          successorRemoteAction,
          successorThirdAction,
          successorFourthAction,
        ],
      },
    };
    const successorLocalDurability = yield* encodedEvidence(fixture.local, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "durability_vote",
      signerAgentId: fixture.local.card.agentId,
      conversationId: n4.membership.descriptor.conversationId,
      membershipHash: n4.membership.hash,
      recordHash: successorRecordHash,
    });
    const successorRemoteDurability = yield* encodedEvidence(fixture.remote, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "durability_vote",
      signerAgentId: fixture.remote.card.agentId,
      conversationId: n4.membership.descriptor.conversationId,
      membershipHash: n4.membership.hash,
      recordHash: successorRecordHash,
    });
    const successorFourthDurability = yield* encodedEvidence(n4.fourth, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "durability_vote",
      signerAgentId: n4.fourth.card.agentId,
      conversationId: n4.membership.descriptor.conversationId,
      membershipHash: n4.membership.hash,
      recordHash: successorRecordHash,
    });
    const certifiedSuccessor: CertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "certified_record",
      actionCertifiedRecord: stagedSuccessor,
      durabilityCertificate: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "durability_certificate",
        recordHash: successorRecordHash,
        votes: [
          successorLocalDurability,
          successorRemoteDurability,
          successorFourthDurability,
        ],
      },
    };
    return { certifiedHead, stagedSuccessor, certifiedSuccessor };
  }).pipe(Effect.orDie);

const decodeCatchUpRequest = (message: SignedMessage) =>
  decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) =>
      body.kind === "direct" && body.packet.kind === "catch_up_request"
        ? Effect.succeed(body.packet)
        : Effect.dieMessage("expected catch-up request"),
    ),
  );

const decodeActionProposal = (
  message: SignedMessage,
  expected = "action proposal",
) =>
  decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) => {
      if (body.kind === "direct" && body.packet.kind === "action_proposal") {
        return Effect.succeed(body.packet);
      }
      const received = body.kind === "evidence" ? body.kind : body.packet.kind;
      return Effect.dieMessage(`expected ${expected}, received ${received}`);
    }),
  );

/**
 * Take the next action proposal from `outbound`, skipping the evidence
 * envelopes queued ahead of it.
 * @param outbound Router queue the engine forwards to.
 * @returns The proposal envelope and its decoded packet; any other direct
 *     packet, or one second without traffic, is a defect.
 */
function takeActionProposalAfterEvidence(
  outbound: Queue.Queue<SignedMessage>,
): Effect.Effect<QueuedActionProposal> {
  return Queue.take(outbound).pipe(
    Effect.timeout("1 second"),
    Effect.flatMap((message) =>
      decodeOuterBody(message.body).pipe(
        Effect.flatMap((body) => {
          if (body.kind === "evidence") {
            return takeActionProposalAfterEvidence(outbound);
          }
          return body.packet.kind === "action_proposal"
            ? Effect.succeed({ message, proposal: body.packet })
            : Effect.dieMessage(
                `expected re-anchored action proposal, received ${body.packet.kind}`,
              );
        }),
      ),
    ),
    Effect.orDie,
  );
}

const stageCatchUpOutbound = (fixture: RecoveryFixture) =>
  Effect.gen(function* () {
    const request: CatchUpRequest = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_request",
      conversationId: fixture.membership.descriptor.conversationId,
      membershipHash: fixture.membership.hash,
      requesterAgentId: fixture.local.card.agentId,
      knownRecordHash: null,
      knownAnchorHash: null,
    };
    const message = yield* signOuterPacket({
      packet: request,
      membership: fixture.membership,
      agentCard: fixture.local.card,
      signingAuthority: fixture.local.authority,
    });
    const canonicalSignedMessage = yield* encodeCanonical(
      SignedMessage,
      message,
    );
    return yield* fixture.store.enqueueOutbound({
      conversationId: request.conversationId,
      messageId: message.messageId,
      canonicalSignedMessage,
    });
  }).pipe(Effect.orDie);

const directPacketIngressFrom = (input: {
  readonly membership: VerifiedMembership;
  readonly sender: IdentityFixture;
  readonly packet: DirectPacket;
  readonly routerInstanceId: typeof RouterInstanceId.Type;
}): Effect.Effect<RouterWorkerIngress<DecodedOuterBody>> =>
  signOuterPacket({
    packet: input.packet,
    membership: input.membership,
    agentCard: input.sender.card,
    signingAuthority: input.sender.authority,
  }).pipe(
    Effect.map(
      (message): RouterWorkerIngress<DecodedOuterBody> => ({
        routerInstanceId: input.routerInstanceId,
        message,
        senderCard: input.sender.card,
        payload: { kind: "direct", packet: input.packet },
      }),
    ),
    Effect.orDie,
  );

const certifiedRecordIngress = (
  fixture: RecoveryFixture,
): Effect.Effect<RouterWorkerIngress<DecodedOuterBody>> =>
  signOuterPacket({
    packet: fixture.certifiedRecord,
    membership: fixture.membership,
    agentCard: fixture.remote.card,
    signingAuthority: fixture.remote.authority,
  }).pipe(
    Effect.map(
      (message): RouterWorkerIngress<DecodedOuterBody> => ({
        routerInstanceId: oldRouterInstanceId,
        message,
        senderCard: fixture.remote.card,
        payload: { kind: "direct", packet: fixture.certifiedRecord },
      }),
    ),
    Effect.orDie,
  );

const retainCertifiedRecord = (fixture: RecoveryFixture) =>
  certifiedRecordIngress(fixture).pipe(
    Effect.flatMap((ingress) => fixture.engine.acceptRouterIngress(ingress)),
    Effect.asVoid,
  );

const restartWithNonLexicalAgentOrder = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeNonLexicalAgentOrderFixture;
        expect(
          compareAgentIds(
            fixture.local.card.agentId,
            fixture.remote.card.agentId,
          ),
        ).toBeLessThan(0);
        expect(fixture.remote.card.agentId < fixture.local.card.agentId).toBe(
          true,
        );

        yield* retainCertifiedRecord(fixture);
        const restarted = yield* makeEndpointEngine(fixture.input);

        expect(
          (yield* restarted.readPendingMessages()).map(
            (message) => message.recordHash,
          ),
        ).toEqual([fixture.certifiedRecord.actionCertifiedRecord.recordHash]);
      }),
    ),
  );

const stageAttachedDissemination = (fixture: RecoveryFixture) =>
  Effect.gen(function* () {
    yield* certifiedRecordIngress(fixture).pipe(
      Effect.flatMap((ingress) => fixture.engine.acceptRouterIngress(ingress)),
    );
    const recovery = yield* fixture.store.recover();
    const record = recovery.certifiedRecords[0];
    if (record === undefined) {
      return yield* Effect.dieMessage("certified record was not retained");
    }
    const delivery = recovery.pendingDeliveries[0];
    if (delivery === undefined) {
      return yield* Effect.dieMessage("remote delivery was not retained");
    }
    yield* fixture.store.promoteRecordForDissemination(record, {
      recipientAgentId: delivery.recipientAgentId,
      canonicalMessage: delivery.canonicalMessage,
    });
    const message = yield* signOuterPacket({
      packet: fixture.certifiedRecord,
      membership: fixture.membership,
      agentCard: fixture.local.card,
      signingAuthority: fixture.local.authority,
    });
    return yield* fixture.store.enqueueDisseminationOutbound(
      {
        conversationId: record.conversationId,
        recordHash: record.recordHash,
        kind: "certified-record",
      },
      {
        conversationId: record.conversationId,
        messageId: message.messageId,
        canonicalSignedMessage: yield* encodeCanonical(SignedMessage, message),
      },
    );
  }).pipe(Effect.orDie);

const catchUpPageIngress = (
  fixture: RecoveryFixture,
  request: CatchUpRequest,
): Effect.Effect<RouterWorkerIngress<DecodedOuterBody>> =>
  Effect.gen(function* () {
    const recordHash = fixture.certifiedRecord.actionCertifiedRecord.recordHash;
    const attestation = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_attestation",
        signerAgentId: fixture.remote.card.agentId,
        request,
        itemKind: "certified_record",
        itemHash: recordHash,
        hasMore: false,
      },
      agentCard: fixture.remote.card,
      signingAuthority: fixture.remote.authority,
    });
    const packet: CatchUpPage = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_page",
      request,
      item: fixture.certifiedRecord,
      hasMore: false,
      attestation: yield* Schema.encode(SignedMessage)(attestation),
    };
    const message = yield* signOuterPacket({
      packet,
      membership: fixture.membership,
      agentCard: fixture.remote.card,
      signingAuthority: fixture.remote.authority,
    });
    const ingress: RouterWorkerIngress<DecodedOuterBody> = {
      routerInstanceId: newRouterInstanceId,
      message,
      senderCard: fixture.remote.card,
      payload: { kind: "direct", packet },
    };
    return ingress;
  }).pipe(Effect.orDie);

const catchUpRecordIngressFrom = (input: {
  readonly membership: VerifiedMembership;
  readonly responder: IdentityFixture;
  readonly request: CatchUpRequest;
  readonly record: CertifiedRecord;
  readonly routerInstanceId: typeof RouterInstanceId.Type;
}): Effect.Effect<RouterWorkerIngress<DecodedOuterBody>> =>
  Effect.gen(function* () {
    const recordHash = input.record.actionCertifiedRecord.recordHash;
    const attestation = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_attestation",
        signerAgentId: input.responder.card.agentId,
        request: input.request,
        itemKind: "certified_record",
        itemHash: recordHash,
        hasMore: false,
      },
      agentCard: input.responder.card,
      signingAuthority: input.responder.authority,
    });
    const packet: CatchUpPage = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_page",
      request: input.request,
      item: input.record,
      hasMore: false,
      attestation: yield* Schema.encode(SignedMessage)(attestation),
    };
    return yield* directPacketIngressFrom({
      membership: input.membership,
      sender: input.responder,
      packet,
      routerInstanceId: input.routerInstanceId,
    });
  }).pipe(Effect.orDie);

const catchUpIncompleteIngressFrom = (input: {
  readonly membership: VerifiedMembership;
  readonly responder: IdentityFixture;
  readonly request: CatchUpRequest;
  readonly routerInstanceId: typeof RouterInstanceId.Type;
}): Effect.Effect<RouterWorkerIngress<DecodedOuterBody>> =>
  Effect.gen(function* () {
    const attestation = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_attestation",
        signerAgentId: input.responder.card.agentId,
        request: input.request,
        itemKind: "incomplete",
        itemHash: null,
        hasMore: false,
      },
      agentCard: input.responder.card,
      signingAuthority: input.responder.authority,
    });
    const packet: CatchUpIncomplete = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_incomplete",
      request: input.request,
      attestation: yield* Schema.encode(SignedMessage)(attestation),
    };
    const message = yield* signOuterPacket({
      packet,
      membership: input.membership,
      agentCard: input.responder.card,
      signingAuthority: input.responder.authority,
    });
    const ingress: RouterWorkerIngress<DecodedOuterBody> = {
      routerInstanceId: input.routerInstanceId,
      message,
      senderCard: input.responder.card,
      payload: { kind: "direct", packet },
    };
    return ingress;
  }).pipe(Effect.orDie);

const catchUpIncompleteIngress = (
  fixture: RecoveryFixture,
  request: CatchUpRequest,
): Effect.Effect<RouterWorkerIngress<DecodedOuterBody>> =>
  catchUpIncompleteIngressFrom({
    membership: fixture.membership,
    responder: fixture.remote,
    request,
    routerInstanceId: newRouterInstanceId,
  });

const decodeReanchorVote = (
  message: SignedMessage,
): Effect.Effect<ReanchorVote> =>
  decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) =>
      body.kind === "evidence"
        ? decodeCanonical(EvidenceStatement, body.message.body)
        : Effect.dieMessage("expected re-anchor evidence"),
    ),
    Effect.flatMap((statement) =>
      statement.kind === "reanchor_vote"
        ? Effect.succeed(statement)
        : Effect.dieMessage("expected re-anchor vote"),
    ),
    Effect.orDie,
  );

const decodeEvidenceKind = (
  message: SignedMessage,
): Effect.Effect<EvidenceStatementValue["kind"]> =>
  decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) =>
      body.kind === "evidence"
        ? decodeCanonical(EvidenceStatement, body.message.body)
        : Effect.dieMessage("expected resumed evidence"),
    ),
    Effect.map((statement) => statement.kind),
    Effect.orDie,
  );

const peerReanchorVoteIngress = (
  fixture: RecoveryFixture,
  proposal: ReanchorVote,
): Effect.Effect<RouterWorkerIngress<DecodedOuterBody>> =>
  peerReanchorVoteIngressFrom({
    membership: fixture.membership,
    responder: fixture.remote,
    proposal,
    routerInstanceId: newRouterInstanceId,
  });

/**
 * Router ingress carrying a re-anchor vote whose outer envelope `responder`
 * signs and addresses to `membership`. The vote's evidence is signed by
 * `evidenceSigner` when given, otherwise by `responder`.
 */
function peerReanchorVoteIngressFrom(input: {
  readonly membership: VerifiedMembership;
  readonly responder: IdentityFixture;
  readonly proposal: ReanchorVote;
  readonly routerInstanceId: typeof RouterInstanceId.Type;
  readonly evidenceSigner?: IdentityFixture;
}): Effect.Effect<RouterWorkerIngress<DecodedOuterBody>> {
  const signer = input.evidenceSigner ?? input.responder;
  return Effect.gen(function* () {
    const evidence = yield* signEvidenceMessage({
      statement: {
        ...input.proposal,
        signerAgentId: signer.card.agentId,
      },
      agentCard: signer.card,
      signingAuthority: signer.authority,
    });
    const message = yield* signOuterEvidence({
      evidence,
      membership: input.membership,
      agentCard: input.responder.card,
      signingAuthority: input.responder.authority,
    });
    const ingress: RouterWorkerIngress<DecodedOuterBody> = {
      routerInstanceId: input.routerInstanceId,
      message,
      senderCard: input.responder.card,
      payload: { kind: "evidence", message: evidence },
    };
    return ingress;
  }).pipe(Effect.orDie);
}

/**
 * A peer's correctly signed vote to re-anchor the fixture conversation at the
 * new Router instance. Only a recovery run started by a Router restart takes
 * such a vote.
 */
const peerReanchorVote = (fixture: RecoveryFixture) =>
  Effect.gen(function* () {
    const { recordCore, recordHash } =
      fixture.certifiedRecord.actionCertifiedRecord;
    const reanchor: ReanchorBody = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "reanchor_body",
      conversationId: recordCore.action.conversationId,
      membershipHash: fixture.membership.hash,
      previousAnchorHash: recordCore.anchorHash,
      selectedRecordHash: recordHash,
      routerInstanceId: newRouterInstanceId,
    };
    const proposal: ReanchorVote = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "reanchor_vote",
      signerAgentId: fixture.remote.card.agentId,
      anchorHash: yield* hashAnchor(reanchor),
      reanchor,
    };
    return yield* peerReanchorVoteIngress(fixture, proposal);
  }).pipe(Effect.orDie);

/**
 * Runs one recovery of the fixture at its unchanged Router instance to
 * completion, handing `during` the moment between the catch-up request and
 * its incomplete answer.
 * @param fixture Endpoint under recovery.
 * @param reason Discontinuity that started the recovery.
 * @param during Work run while the recovery is still active.
 * @returns What `during` returned, once recovery has completed.
 */
const runSameInstanceRecovery = <A, E>(
  fixture: RecoveryFixture,
  reason: RouterDiscontinuityReason,
  during: Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
    yield* fixture.engine.abandonVolatileFolds(reason);
    const recovering = yield* Effect.fork(
      fixture.engine.recoverCertifiedHistory({
        reason,
        anchor: { routerInstanceId: oldRouterInstanceId, pollCursor },
        resume: (outboundId) =>
          forwardStoredOutbound(
            fixture.store,
            fixture.normalOutbound,
            outboundId,
          ),
        send: ({ message }) =>
          Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
      }),
    );
    const request = yield* Queue.take(recoveryOutbound).pipe(
      Effect.timeout("1 second"),
      Effect.flatMap(decodeCatchUpRequest),
    );
    const result = yield* during;
    yield* catchUpIncompleteIngress(fixture, request).pipe(
      Effect.flatMap((ingress) =>
        fixture.engine.acceptRecoveryIngress(ingress),
      ),
    );
    yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));
    return result;
  });

const ignoresReanchorVoteDuringFeedGapRecovery = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const disposition = yield* runSameInstanceRecovery(
          fixture,
          "feed_gap",
          peerReanchorVote(fixture).pipe(
            Effect.flatMap((ingress) =>
              fixture.engine.acceptRecoveryIngress(ingress),
            ),
          ),
        );
        expect(disposition).toBe(ignoredDisposition);
      }),
    ),
  );

const ignoresReanchorVoteAfterRecovery = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* runSameInstanceRecovery(fixture, "feed_gap", Effect.void);
        const disposition = yield* peerReanchorVote(fixture).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        expect(disposition).toBe(ignoredDisposition);
      }),
    ),
  );

const completeRestartRecovery = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        const staleOutbound = yield* stageCatchUpOutbound(fixture);
        yield* fixture.engine.abandonVolatileFolds("router_restarted");
        const recovering = yield* Effect.fork(
          fixture.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: {
              routerInstanceId: newRouterInstanceId,
              pollCursor,
            },
            resume: (outboundId) =>
              forwardStoredOutbound(
                fixture.store,
                recoveryOutbound,
                outboundId,
              ),
            send: ({ message }) =>
              Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const firstOutbound = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
        );
        expect(firstOutbound.messageId).not.toBe(staleOutbound.messageId);
        const firstRequest = yield* decodeCatchUpRequest(firstOutbound);
        yield* catchUpPageIngress(fixture, firstRequest).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* fixture.engine.abandonVolatileFolds("router_restarted");
        const terminalRequest = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        yield* catchUpIncompleteIngress(fixture, terminalRequest).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const proposal = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeReanchorVote),
        );
        expect(proposal.reanchor).toMatchObject({
          previousAnchorHash:
            fixture.certifiedRecord.actionCertifiedRecord.recordCore.anchorHash,
          selectedRecordHash:
            fixture.certifiedRecord.actionCertifiedRecord.recordHash,
          routerInstanceId: newRouterInstanceId,
        });
        yield* peerReanchorVoteIngress(fixture, proposal).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const completed = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap((message) => decodeOuterBody(message.body)),
        );
        expect(completed).toMatchObject({
          kind: "direct",
          packet: {
            kind: "completed_reanchor",
            anchorHash: proposal.anchorHash,
          },
        });
        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));
        yield* fixture.engine.drainOutbound;
        const recovered = yield* fixture.store.recover();
        expect(recovered.certifiedRecords).toHaveLength(1);
        expect(recovered.outboundMessages).toHaveLength(0);
        expect(recovered.positions[0]?.currentAnchorHash).toBe(
          proposal.anchorHash,
        );
        const resumedActionEvidence = yield* Queue.take(
          fixture.normalOutbound,
        ).pipe(Effect.timeout("1 second"), Effect.flatMap(decodeEvidenceKind));
        const resumedDurabilityEvidence = yield* Queue.take(
          fixture.normalOutbound,
        ).pipe(Effect.timeout("1 second"), Effect.flatMap(decodeEvidenceKind));
        expect(resumedActionEvidence).toBe(actionSignatureKind);
        expect(resumedDurabilityEvidence).toBe(durabilityVoteKind);

        const sending = yield* Effect.fork(
          fixture.engine.send(
            yield* Effect.all({
              to: Schema.decodeUnknown(MessageAddressInput)(
                `agent:${fixture.remote.card.agentName}`,
              ),
              content: Schema.decodeUnknown(Content)([
                { type: "text", text: "normal traffic resumes" },
              ]),
            }),
          ),
        );
        const resumedProposal = yield* Queue.take(fixture.normalOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeActionProposal),
        );
        expect(resumedProposal.action).toMatchObject({
          kind: "POST",
          anchorHash: proposal.anchorHash,
        });
        yield* Fiber.interrupt(sending);
      }),
    ),
  );

const reproposesPendingPostAfterRestart = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pendingOutboundIds = yield* Queue.unbounded<string>();
        const holdOutbound = yield* Ref.make(false);
        const fixture = yield* makeFixtureWithRouter(
          makeHeldRouter({ holdOutbound, pendingOutboundIds }),
        );
        yield* retainCertifiedRecord(fixture);
        yield* fixture.engine.drainOutbound.pipe(Effect.orDie);
        yield* Ref.set(holdOutbound, true);
        const sending = yield* Effect.fork(
          fixture.engine.send(
            yield* Effect.all({
              to: Schema.decodeUnknown(MessageAddressInput)(
                `agent:${fixture.remote.card.agentName}`,
              ),
              content: Schema.decodeUnknown(Content)([
                { type: "text", text: "survive Router restart" },
              ]),
            }),
          ),
        );
        const staleOutboundId = yield* Queue.take(pendingOutboundIds).pipe(
          Effect.timeout("1 second"),
        );
        const before = yield* fixture.store.recover();
        expect(before.outboundMessages).toHaveLength(1);
        const staleOutbound = before.outboundMessages[0];
        if (staleOutbound === undefined) {
          return yield* Effect.dieMessage("pending POST was not retained");
        }
        expect(staleOutbound.outboundId).toBe(staleOutboundId);
        const staleProposal = yield* decodeCanonical(
          SignedMessage,
          staleOutbound.canonicalSignedMessage,
        ).pipe(
          Effect.flatMap((message) =>
            decodeActionProposal(message, "old-instance action proposal"),
          ),
        );
        if (staleProposal.action.kind !== "POST") {
          return yield* Effect.dieMessage("expected an old-instance POST");
        }
        const postId = staleProposal.action.postIntent.postId;
        expect(staleProposal.action.anchorHash).toBe(
          fixture.certifiedRecord.actionCertifiedRecord.recordCore.anchorHash,
        );
        const staleActionHash = yield* hashAction(staleProposal.action);

        yield* Queue.takeAll(fixture.normalOutbound);
        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        const resumedOutbound = fixture.normalOutbound;
        yield* fixture.engine.abandonVolatileFolds("router_restarted");
        const recovering = yield* Effect.fork(
          fixture.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: {
              routerInstanceId: newRouterInstanceId,
              pollCursor,
            },
            resume: (outboundId) =>
              forwardStoredOutbound(fixture.store, resumedOutbound, outboundId),
            send: ({ message }) =>
              Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const request = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        yield* catchUpIncompleteIngress(fixture, request).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const reanchor = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeReanchorVote),
        );
        yield* peerReanchorVoteIngress(fixture, reanchor).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Queue.take(recoveryOutbound).pipe(Effect.timeout("1 second"));
        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));
        yield* Ref.set(holdOutbound, false);
        yield* fixture.engine.drainOutbound;

        const { message: reproposedMessage, proposal: reproposed } =
          yield* takeActionProposalAfterEvidence(resumedOutbound);
        if (reproposed.action.kind !== "POST") {
          return yield* Effect.dieMessage("expected a re-anchored POST");
        }
        expect(reproposedMessage.messageId).not.toBe(staleOutbound.messageId);
        expect(reproposed.action.postIntent.postId).toBe(postId);
        expect(reproposed.action.postIntentHash).toBe(
          staleProposal.action.postIntentHash,
        );
        expect(reproposed.action.previousRecordHash).toBe(
          staleProposal.action.previousRecordHash,
        );
        expect(reproposed.action.anchorHash).toBe(reanchor.anchorHash);
        expect(yield* hashAction(reproposed.action)).not.toBe(staleActionHash);
        expect(
          "outbound" in (yield* fixture.store.beginOutbound(staleOutboundId)),
        ).toBe(false);
        expect((yield* fixture.store.recover()).outboundMessages).toHaveLength(
          0,
        );
        expect(yield* Queue.size(pendingOutboundIds)).toBe(0);
        yield* Fiber.interrupt(sending);
      }),
    ),
  );

const recoverSameRouterInstance = (reason: RouterDiscontinuityReason) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const sending = yield* Effect.fork(
          fixture.engine.send(
            yield* Effect.all({
              to: Schema.decodeUnknown(MessageAddressInput)(
                `agent:${fixture.remote.card.agentName}`,
              ),
              content: Schema.decodeUnknown(Content)([
                { type: "text", text: "retain this proposal" },
              ]),
            }),
          ),
        );
        yield* Queue.take(fixture.normalOutbound).pipe(
          Effect.timeout("1 second"),
        );
        const retained = yield* stageCatchUpOutbound(fixture);
        yield* runSameInstanceRecovery(fixture, reason, Effect.void);
        yield* fixture.engine.drainOutbound;
        const resumed = yield* Queue.take(fixture.normalOutbound).pipe(
          Effect.timeout("1 second"),
        );
        expect(yield* encodeCanonical(SignedMessage, resumed)).toEqual(
          retained.canonicalSignedMessage,
        );
        yield* Fiber.interrupt(sending);
      }),
    ),
  );

const recoverColdStartAtUnchangedInstance = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* retainCertifiedRecord(fixture);
        const retained = yield* stageCatchUpOutbound(fixture);
        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        const resumedOutbound = fixture.normalOutbound;
        yield* fixture.engine.abandonVolatileFolds("router_restarted");
        const recovering = yield* Effect.fork(
          fixture.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: {
              routerInstanceId: oldRouterInstanceId,
              pollCursor,
            },
            resume: (outboundId) =>
              forwardStoredOutbound(fixture.store, resumedOutbound, outboundId),
            send: ({ message }) =>
              Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const request = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        yield* catchUpIncompleteIngressFrom({
          membership: fixture.membership,
          responder: fixture.remote,
          request,
          routerInstanceId: oldRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));
        expect(yield* Queue.size(recoveryOutbound)).toBe(0);
        expect(yield* Queue.size(resumedOutbound)).toBe(0);
        yield* fixture.engine.drainOutbound;
        const recovered = yield* fixture.store.recover();
        expect(recovered.stagedReanchors).toHaveLength(0);
        expect(recovered.anchors).toHaveLength(1);
        expect(recovered.positions[0]?.currentAnchorHash).toBe(
          fixture.certifiedRecord.actionCertifiedRecord.recordCore.anchorHash,
        );
        const resumedIds = (yield* Queue.takeAll(resumedOutbound)).pipe(
          Chunk.map((message) => message.messageId),
          Chunk.toReadonlyArray,
        );
        expect(resumedIds).toContain(retained.messageId);
      }),
    ),
  );

const takeAllMessageIds = (queue: Queue.Queue<SignedMessage>) =>
  Queue.takeAll(queue).pipe(
    Effect.map((messages) =>
      Chunk.toReadonlyArray(
        Chunk.map(messages, (message) => message.messageId),
      ),
    ),
  );

const recoverMixedRouterInstances = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* retainCertifiedRecord(fixture);
        const n4 = yield* addN4Foundation(fixture, newRouterInstanceId);
        const unchanged = fixture.membership.descriptor.conversationId;
        const changed = n4.membership.descriptor.conversationId;
        const retainedUnchanged = yield* stageCatchUpOutbound(fixture);
        const staleChanged = yield* stageCatchUpOutbound({
          ...fixture,
          membership: n4.membership,
        });
        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        const resumedOutbound = fixture.normalOutbound;
        yield* n4.engine.abandonVolatileFolds("router_restarted");
        const recovering = yield* Effect.fork(
          n4.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: { routerInstanceId: oldRouterInstanceId, pollCursor },
            resume: (outboundId) =>
              forwardStoredOutbound(fixture.store, resumedOutbound, outboundId),
            send: ({ message }) =>
              Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const requests = yield* Effect.forEach(
          [1, 2],
          () =>
            Queue.take(recoveryOutbound).pipe(
              Effect.timeout("1 second"),
              Effect.flatMap(decodeCatchUpRequest),
            ),
          { concurrency: 1 },
        );
        const unchangedRequest = requests.find(
          (request) => request.conversationId === unchanged,
        );
        const changedRequest = requests.find(
          (request) => request.conversationId === changed,
        );
        if (unchangedRequest === undefined || changedRequest === undefined) {
          return yield* Effect.dieMessage(
            "expected one request per conversation",
          );
        }
        yield* catchUpIncompleteIngressFrom({
          membership: fixture.membership,
          responder: fixture.remote,
          request: unchangedRequest,
          routerInstanceId: oldRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );

        const certified = fixture.certifiedRecord.actionCertifiedRecord;
        const sameInstanceBody: ReanchorVote["reanchor"] = {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "reanchor_body",
          conversationId: unchanged,
          membershipHash: fixture.membership.hash,
          previousAnchorHash: certified.recordCore.anchorHash,
          selectedRecordHash: certified.recordHash,
          routerInstanceId: oldRouterInstanceId,
        };
        yield* peerReanchorVoteIngressFrom({
          membership: fixture.membership,
          responder: fixture.remote,
          proposal: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "reanchor_vote",
            signerAgentId: fixture.remote.card.agentId,
            anchorHash: yield* hashAnchor(sameInstanceBody),
            reanchor: sameInstanceBody,
          },
          routerInstanceId: oldRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        expect(yield* Queue.size(recoveryOutbound)).toBe(0);

        yield* Effect.forEach(
          [fixture.remote, n4.third, n4.fourth],
          (responder) =>
            catchUpIncompleteIngressFrom({
              membership: n4.membership,
              responder,
              request: changedRequest,
              routerInstanceId: oldRouterInstanceId,
            }).pipe(
              Effect.flatMap((ingress) =>
                n4.engine.acceptRecoveryIngress(ingress),
              ),
            ),
          { concurrency: 1, discard: true },
        );
        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));

        expect(yield* Queue.size(resumedOutbound)).toBe(0);
        yield* n4.engine.drainOutbound;
        const after = yield* fixture.store.recover();
        expect(after.stagedReanchors).toEqual([]);
        expect(
          after.evidence.filter((evidence) => evidence.kind === "reanchor"),
        ).toEqual([]);
        expect(
          after.positions.find(
            (position) => position.conversationId === unchanged,
          )?.currentAnchorHash,
        ).toBe(certified.recordCore.anchorHash);
        const changedAnchor = after.anchors.find(
          (stored) => stored.conversationId === changed,
        );
        if (changedAnchor === undefined) {
          return yield* Effect.dieMessage(
            "changed conversation lost its anchor",
          );
        }
        expect(
          (yield* decodeCanonical(
            GenesisAnchorBody,
            changedAnchor.canonicalAnchor,
          )).routerInstanceId,
        ).toBe(oldRouterInstanceId);
        const resumedIds = yield* takeAllMessageIds(resumedOutbound);
        expect(resumedIds).toContain(retainedUnchanged.messageId);
        expect(resumedIds).not.toContain(staleChanged.messageId);
        expect(after.outboundMessages).toEqual([]);
      }),
    ),
  );

/** One Router send held until the test releases it. */
interface HeldSend {
  readonly outboundId: string;
  readonly release: Deferred.Deferred<undefined>;
}

/**
 * Hold every Router send until the test releases it, then forward it once.
 * @param sends Receives each attempted send with its release latch.
 * @returns A fixture Router whose sends complete in test-chosen order.
 */
function makeGatedRouter(sends: Queue.Queue<HeldSend>) {
  return (context: FixtureRouterContext): EngineRouterPort => ({
    ...makeFixtureRouter(context),
    send: (outboundId) =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<undefined>();
        yield* Queue.offer(sends, { outboundId, release });
        yield* Deferred.await(release);
        yield* forwardStoredOutbound(
          context.store,
          context.normalOutbound,
          outboundId,
        );
      }),
  });
}

const takeHeldSend = (sends: Queue.Queue<HeldSend>) =>
  Queue.take(sends).pipe(Effect.timeout("1 second"), Effect.orDie);

const releaseHeldSend = (held: HeldSend) =>
  Deferred.succeed(held.release, undefined);

/**
 * Queue one normal outbound envelope by answering a peer catch-up request.
 * @param fixture Engine that answers outside recovery.
 * @returns The queued outbox row.
 */
const queuePeerCatchUpResponse = (fixture: RecoveryFixture) =>
  Effect.gen(function* () {
    const before = yield* fixture.store.recover();
    const request: CatchUpRequest = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_request",
      conversationId: fixture.membership.descriptor.conversationId,
      membershipHash: fixture.membership.hash,
      requesterAgentId: fixture.remote.card.agentId,
      knownRecordHash: null,
      knownAnchorHash: null,
    };
    const ingress = yield* directPacketIngressFrom({
      membership: fixture.membership,
      sender: fixture.remote,
      packet: request,
      routerInstanceId: oldRouterInstanceId,
    });
    yield* fixture.engine.acceptRouterIngress(ingress);
    const after = yield* fixture.store.recover();
    const queued = after.outboundMessages.filter(
      (row) =>
        !before.outboundMessages.some(
          (prior) => prior.outboundId === row.outboundId,
        ),
    );
    const row = queued[0];
    if (queued.length !== 1 || row === undefined) {
      return yield* Effect.dieMessage("expected one queued catch-up response");
    }
    return row;
  }).pipe(Effect.orDie);

const recoverWhileDrainAwaitsWorker = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sends = yield* Queue.unbounded<HeldSend>();
        const fixture = yield* makeFixtureWithRouter(makeGatedRouter(sends));
        const queued = yield* queuePeerCatchUpResponse(fixture);
        const draining = yield* Effect.fork(fixture.engine.drainOutbound);
        const held = yield* takeHeldSend(sends);
        expect(held.outboundId).toBe(queued.outboundId);

        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        const resumedOutbound = yield* Queue.unbounded<SignedMessage>();
        yield* fixture.engine.abandonVolatileFolds("feed_gap");
        const recovering = yield* Effect.fork(
          fixture.engine.recoverCertifiedHistory({
            reason: "feed_gap",
            anchor: { routerInstanceId: oldRouterInstanceId, pollCursor },
            resume: (outboundId) =>
              forwardStoredOutbound(fixture.store, resumedOutbound, outboundId),
            send: ({ message }) =>
              Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const request = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        yield* catchUpIncompleteIngressFrom({
          membership: fixture.membership,
          responder: fixture.remote,
          request,
          routerInstanceId: oldRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));

        yield* releaseHeldSend(held);
        yield* Fiber.join(draining).pipe(Effect.timeout("1 second"));
        expect(yield* takeAllMessageIds(fixture.normalOutbound)).toEqual([
          queued.messageId,
        ]);
        expect(yield* takeAllMessageIds(resumedOutbound)).toEqual([]);
        expect((yield* fixture.store.recover()).outboundMessages).toEqual([]);
      }),
    ),
  );

const concurrentDrainsSendOnceInOrder = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sends = yield* Queue.unbounded<HeldSend>();
        const fixture = yield* makeFixtureWithRouter(makeGatedRouter(sends));
        const first = yield* queuePeerCatchUpResponse(fixture);
        const second = yield* queuePeerCatchUpResponse(fixture);

        const leading = yield* Effect.fork(fixture.engine.drainOutbound);
        const leadingFirst = yield* takeHeldSend(sends);
        const trailing = yield* Effect.fork(fixture.engine.drainOutbound);
        const trailingFirst = yield* takeHeldSend(sends);
        expect([leadingFirst.outboundId, trailingFirst.outboundId]).toEqual([
          first.outboundId,
          first.outboundId,
        ]);

        yield* releaseHeldSend(trailingFirst);
        const trailingSecond = yield* takeHeldSend(sends);
        expect(trailingSecond.outboundId).toBe(second.outboundId);
        yield* releaseHeldSend(leadingFirst);
        const leadingSecond = yield* takeHeldSend(sends);
        expect(leadingSecond.outboundId).toBe(second.outboundId);
        yield* releaseHeldSend(trailingSecond);
        yield* releaseHeldSend(leadingSecond);
        yield* Fiber.join(leading).pipe(Effect.timeout("1 second"));
        yield* Fiber.join(trailing).pipe(Effect.timeout("1 second"));

        expect(yield* takeAllMessageIds(fixture.normalOutbound)).toEqual([
          first.messageId,
          second.messageId,
        ]);
        expect((yield* fixture.store.recover()).outboundMessages).toEqual([]);
        yield* fixture.engine.drainOutbound;
        expect(yield* Queue.size(sends)).toBe(0);
      }),
    ),
  );

const staleDrainKeepsLaterHead = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sends = yield* Queue.unbounded<HeldSend>();
        const fixture = yield* makeFixtureWithRouter(makeGatedRouter(sends));
        const first = yield* queuePeerCatchUpResponse(fixture);

        const stale = yield* Effect.fork(fixture.engine.drainOutbound);
        const staleFirst = yield* takeHeldSend(sends);
        const current = yield* Effect.fork(fixture.engine.drainOutbound);
        const currentFirst = yield* takeHeldSend(sends);
        yield* releaseHeldSend(currentFirst);
        yield* Fiber.join(current).pipe(Effect.timeout("1 second"));

        const second = yield* queuePeerCatchUpResponse(fixture);
        yield* releaseHeldSend(staleFirst);
        const staleSecond = yield* takeHeldSend(sends);
        expect(staleSecond.outboundId).toBe(second.outboundId);
        yield* releaseHeldSend(staleSecond);
        yield* Fiber.join(stale).pipe(Effect.timeout("1 second"));

        expect(yield* takeAllMessageIds(fixture.normalOutbound)).toEqual([
          first.messageId,
          second.messageId,
        ]);
        expect((yield* fixture.store.recover()).outboundMessages).toEqual([]);
      }),
    ),
  );

interface RestartingRouterInput {
  readonly engineReady: Deferred.Deferred<EndpointEngine>;
  readonly restartPending: Ref.Ref<boolean>;
  readonly recoveryOutbound: Queue.Queue<SignedMessage>;
  readonly recovered: Deferred.Deferred<undefined>;
}

/**
 * Recover a Router restart on the sending fiber, as the worker does when a
 * send observes `router_restarted`, then fail that send as a discontinuity.
 * @param input Engine latch, one-shot restart flag, and recovery observers.
 * @returns A fixture Router whose first send runs recovery in place.
 */
function makeRestartingRouter(input: RestartingRouterInput) {
  return (context: FixtureRouterContext): EngineRouterPort => {
    const recover = (engine: EndpointEngine) =>
      engine.abandonVolatileFolds("router_restarted").pipe(
        Effect.zipRight(
          engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: { routerInstanceId: newRouterInstanceId, pollCursor },
            resume: (outboundId) =>
              forwardStoredOutbound(
                context.store,
                context.normalOutbound,
                outboundId,
              ),
            send: ({ message }) =>
              Queue.offer(input.recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        ),
        Effect.orDie,
        Effect.zipRight(Deferred.succeed(input.recovered, undefined)),
        Effect.zipRight(Effect.fail(new RouterWorkerDiscontinuityError())),
      );
    return {
      ...makeFixtureRouter(context),
      send: (outboundId) =>
        Ref.getAndSet(input.restartPending, false).pipe(
          Effect.flatMap((restarted) =>
            restarted
              ? Deferred.await(input.engineReady).pipe(Effect.flatMap(recover))
              : forwardStoredOutbound(
                  context.store,
                  context.normalOutbound,
                  outboundId,
                ),
          ),
        ),
    };
  };
}

const drainRecoversRouterRestartOnItsOwnFiber = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engineReady = yield* Deferred.make<EndpointEngine>();
        const restartPending = yield* Ref.make(true);
        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        const recovered = yield* Deferred.make<undefined>();
        const fixture = yield* makeFixtureWithRouter(
          makeRestartingRouter({
            engineReady,
            restartPending,
            recoveryOutbound,
            recovered,
          }),
        );
        yield* Deferred.succeed(engineReady, fixture.engine);
        yield* queuePeerCatchUpResponse(fixture);

        const draining = yield* Effect.fork(fixture.engine.drainOutbound);
        const request = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        yield* catchUpIncompleteIngress(fixture, request).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const drained = yield* Fiber.await(draining).pipe(
          Effect.timeout("1 second"),
        );

        expect(drained).toStrictEqual(
          Exit.fail(new EngineOutboundError({ reason: "network" })),
        );
        expect(yield* Deferred.isDone(recovered)).toBe(true);
        const after = yield* fixture.store.recover();
        expect(after.outboundMessages).toEqual([]);
        const storedAnchor = after.anchors[0];
        if (storedAnchor === undefined) {
          return yield* Effect.dieMessage("restarted anchor was not stored");
        }
        const restartedAnchor = yield* decodeCanonical(
          GenesisAnchorBody,
          storedAnchor.canonicalAnchor,
        );
        expect(restartedAnchor.routerInstanceId).toBe(newRouterInstanceId);
      }),
    ),
  );

const recoverDisseminationObligations = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const stale = yield* stageAttachedDissemination(fixture);
        const before = yield* fixture.store.recover();
        expect(before.disseminationObligations).toHaveLength(0);
        expect(before.outboundMessages).toHaveLength(1);
        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        const resumedOutbound = fixture.normalOutbound;
        yield* fixture.engine.abandonVolatileFolds("router_restarted");
        const recovering = yield* Effect.fork(
          fixture.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: {
              routerInstanceId: newRouterInstanceId,
              pollCursor,
            },
            resume: (outboundId) =>
              forwardStoredOutbound(fixture.store, resumedOutbound, outboundId),
            send: ({ message }) =>
              Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const request = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        yield* catchUpIncompleteIngress(fixture, request).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const proposal = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeReanchorVote),
        );
        yield* peerReanchorVoteIngress(fixture, proposal).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap((message) => decodeOuterBody(message.body)),
        );
        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));
        yield* fixture.engine.drainOutbound;
        const rebuilt = yield* Queue.take(resumedOutbound).pipe(
          Effect.timeout("1 second"),
        );
        expect(rebuilt.messageId).not.toBe(stale.messageId);
        expect(yield* decodeOuterBody(rebuilt.body)).toMatchObject({
          kind: "direct",
          packet: { kind: "certified_record" },
        });
        expect(
          yield* Queue.take(resumedOutbound).pipe(
            Effect.timeout("1 second"),
            Effect.flatMap(decodeEvidenceKind),
          ),
        ).toBe(actionSignatureKind);
        expect(
          yield* Queue.take(resumedOutbound).pipe(
            Effect.timeout("1 second"),
            Effect.flatMap(decodeEvidenceKind),
          ),
        ).toBe(durabilityVoteKind);
        expect(yield* Queue.size(resumedOutbound)).toBe(0);
        const after = yield* fixture.store.recover();
        expect(after.disseminationObligations).toHaveLength(0);
        expect(after.outboundMessages).toHaveLength(0);
      }),
    ),
  );

const recoverWhileNormalSendIsHeld = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sendEntered = yield* Deferred.make<undefined>();
        const releaseSend = yield* Deferred.make<undefined>();
        const fixture = yield* makeFixtureWithRouter((context) => {
          const router = makeFixtureRouter(context);
          return {
            ...router,
            send: (outboundId) =>
              Deferred.succeed(sendEntered, undefined).pipe(
                Effect.zipRight(Deferred.await(releaseSend)),
                Effect.zipRight(router.send(outboundId)),
              ),
          };
        });
        const sending = yield* Effect.forkScoped(
          fixture.engine.send({
            to: Schema.decodeUnknownSync(MessageAddressInput)(
              `agent:${fixture.remote.card.agentName}`,
            ),
            content: [{ type: "text", text: "retained during recovery" }],
          }),
        );
        yield* Deferred.await(sendEntered).pipe(Effect.timeout("1 second"));
        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        yield* fixture.engine.abandonVolatileFolds("router_restarted");
        const recovering = yield* Effect.forkScoped(
          fixture.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: { routerInstanceId: oldRouterInstanceId, pollCursor },
            resume: () =>
              Effect.dieMessage("normal replay must wait for active ingress"),
            send: ({ message }) =>
              Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const request = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        yield* catchUpIncompleteIngress(fixture, request).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));
        expect((yield* fixture.store.recover()).postIntents).toHaveLength(1);
        yield* Deferred.succeed(releaseSend, undefined);
        yield* fixture.engine.drainOutbound.pipe(Effect.timeout("1 second"));
        expect((yield* fixture.store.recover()).outboundMessages).toHaveLength(
          0,
        );
        yield* Fiber.interrupt(sending);
      }),
    ),
  );

const restartEmptyConversation = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        yield* fixture.engine.abandonVolatileFolds("router_restarted");
        const recovering = yield* Effect.fork(
          fixture.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: {
              routerInstanceId: newRouterInstanceId,
              pollCursor,
            },
            resume: (outboundId) =>
              forwardStoredOutbound(
                fixture.store,
                recoveryOutbound,
                outboundId,
              ),
            send: ({ message }) =>
              Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const request = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        yield* catchUpIncompleteIngress(fixture, request).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));
        const recovered = yield* fixture.store.recover();
        expect(recovered.stagedReanchors).toHaveLength(0);
        expect(recovered.positions[0]?.headRecordHash).toBeUndefined();
        expect(recovered.anchors).toHaveLength(1);
        const storedAnchor = recovered.anchors[0];
        if (storedAnchor === undefined) {
          return yield* Effect.dieMessage("replacement anchor was not stored");
        }
        const restartedAnchor = yield* decodeCanonical(
          GenesisAnchorBody,
          storedAnchor.canonicalAnchor,
        );
        expect(restartedAnchor.routerInstanceId).toBe(newRouterInstanceId);
      }),
    ),
  );

/**
 * Starts a restart recovery at the new Router instance and waits until it has
 * sent its first catch-up request, so the run is active.
 * @param fixture Endpoint under recovery.
 * @param outbound Queue that receives the envelopes `send` forwards.
 * @param send How the run sends; by default every envelope goes to `outbound`.
 * @returns The running recovery and its first catch-up request.
 */
const startRestartRecovery = (
  fixture: RecoveryFixture,
  outbound: Queue.Queue<SignedMessage>,
  send?: RouterWorkerRecovery["send"],
) =>
  Effect.gen(function* () {
    yield* fixture.engine.abandonVolatileFolds("router_restarted");
    const recovery = yield* Effect.fork(
      fixture.engine.recoverCertifiedHistory({
        reason: "router_restarted",
        anchor: {
          routerInstanceId: newRouterInstanceId,
          pollCursor,
        },
        resume: () => Effect.void,
        send:
          send ??
          (({ message }) => Queue.offer(outbound, message).pipe(Effect.asVoid)),
      }),
    );
    const request = yield* Queue.take(outbound).pipe(
      Effect.timeout("1 second"),
      Effect.flatMap(decodeCatchUpRequest),
    );
    return { recovery, request };
  });

/**
 * Runs a restart recovery that re-anchors the fixture conversation at the new
 * Router instance with the peer's vote, and interrupts it while the endpoint
 * is sending the completed re-anchor. The store has committed the new anchor
 * by then, so a later restart recovery finds the conversation anchored.
 * @param fixture Endpoint under recovery, holding a retained certified record.
 * @returns The endpoint's re-anchor vote and the completed re-anchor it was sending.
 */
const reanchorUntilCompletionSend = (fixture: RecoveryFixture) =>
  Effect.gen(function* () {
    const outbound = yield* Queue.unbounded<SignedMessage>();
    const completedSend = yield* Deferred.make<DirectPacket>();
    const { recovery, request } = yield* startRestartRecovery(
      fixture,
      outbound,
      ({ message }) =>
        decodeOuterBody(message.body).pipe(
          Effect.orDie,
          Effect.flatMap((body) =>
            body.kind === "direct" && body.packet.kind === "completed_reanchor"
              ? Deferred.succeed(completedSend, body.packet).pipe(
                  Effect.zipRight(Effect.never),
                )
              : Queue.offer(outbound, message).pipe(Effect.asVoid),
          ),
        ),
    );
    yield* catchUpIncompleteIngress(fixture, request).pipe(
      Effect.flatMap((ingress) =>
        fixture.engine.acceptRecoveryIngress(ingress),
      ),
    );
    const proposal = yield* Queue.take(outbound).pipe(
      Effect.timeout("1 second"),
      Effect.flatMap(decodeReanchorVote),
    );
    yield* peerReanchorVoteIngress(fixture, proposal).pipe(
      Effect.flatMap((ingress) =>
        fixture.engine.acceptRecoveryIngress(ingress),
      ),
    );
    const completed = yield* Deferred.await(completedSend).pipe(
      Effect.timeout("1 second"),
    );
    yield* Fiber.interrupt(recovery);
    return { proposal, completed };
  });

const ignoresRelayedCompletionForAnchoredConversation = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* retainCertifiedRecord(fixture);
        const { completed } = yield* reanchorUntilCompletionSend(fixture);
        const { recovery } = yield* startRestartRecovery(
          fixture,
          yield* Queue.unbounded<SignedMessage>(),
        );
        const disposition = yield* directPacketIngressFrom({
          membership: fixture.membership,
          sender: fixture.remote,
          packet: completed,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        expect(disposition).toBe(ignoredDisposition);
        yield* Fiber.interrupt(recovery);
      }),
    ),
  );

/**
 * The stable evidence message an outer evidence envelope carries, encoded as
 * a certificate holds it.
 * @param message Outer envelope whose body is evidence.
 * @returns The encoded inner evidence message.
 */
const carriedEvidence = (message: SignedMessage) =>
  decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) =>
      body.kind === "evidence"
        ? Schema.encode(SignedMessage)(body.message)
        : Effect.dieMessage("expected evidence"),
    ),
    Effect.orDie,
  );

/**
 * Starts a restart recovery of the fixture's retained record and answers its
 * catch-up request as incomplete, so the endpoint sends its own re-anchor vote
 * and waits for the peer's.
 * @param fixture Endpoint under recovery.
 * @returns The running recovery, the endpoint's vote, and that vote encoded.
 */
const proposeAtRestart = (fixture: RecoveryFixture) =>
  Effect.gen(function* () {
    yield* retainCertifiedRecord(fixture);
    const outbound = yield* Queue.unbounded<SignedMessage>();
    const { recovery, request } = yield* startRestartRecovery(
      fixture,
      outbound,
    );
    yield* catchUpIncompleteIngress(fixture, request).pipe(
      Effect.flatMap((ingress) =>
        fixture.engine.acceptRecoveryIngress(ingress),
      ),
    );
    const voteMessage = yield* Queue.take(outbound).pipe(
      Effect.timeout("1 second"),
    );
    return {
      recovery,
      proposal: yield* decodeReanchorVote(voteMessage),
      localVote: yield* carriedEvidence(voteMessage),
    };
  });

/**
 * A peer that reached the threshold first relays the completed re-anchor; the
 * endpoint still re-anchoring takes its votes, reports it accepted, and adopts
 * its anchor. Protects the receiving side of a relayed completion; fails when
 * a completion whose votes the run takes is reported ignored, or its votes do
 * not reach the run.
 */
const adoptsRelayedCompletionForReanchoringConversation = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const { recovery, proposal, localVote } =
          yield* proposeAtRestart(fixture);
        const peerVote = yield* encodedEvidence(fixture.remote, {
          ...proposal,
          signerAgentId: fixture.remote.card.agentId,
        });
        const completed: DirectPacket = {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "completed_reanchor",
          anchorHash: proposal.anchorHash,
          reanchor: proposal.reanchor,
          certificate: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "reanchor_certificate",
            anchorHash: proposal.anchorHash,
            votes: [localVote, peerVote],
          },
        };

        const disposition = yield* directPacketIngressFrom({
          membership: fixture.membership,
          sender: fixture.remote,
          packet: completed,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(disposition).toBe(acceptedDisposition);
        expect(
          (yield* fixture.store.recover()).positions[0]?.currentAnchorHash,
        ).toBe(proposal.anchorHash);
      }),
    ),
  );

/**
 * A peer vote naming an anchor hash its re-anchor body does not hash to is
 * reported ignored, and the peer's genuine vote still completes the
 * re-anchor. Protects a vote's binding to the anchor it names; fails when
 * that check is dropped, or a vote the run declines is reported accepted.
 */
const ignoresReanchorVoteWithMismatchedAnchorHash = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const { recovery, proposal } = yield* proposeAtRestart(fixture);
        const otherAnchorHash = yield* hashAnchor({
          ...proposal.reanchor,
          routerInstanceId: oldRouterInstanceId,
        });

        const mismatched = yield* peerReanchorVoteIngress(fixture, {
          ...proposal,
          anchorHash: otherAnchorHash,
        }).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const genuine = yield* peerReanchorVoteIngress(fixture, proposal).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(mismatched).toBe(ignoredDisposition);
        expect(genuine).toBe(acceptedDisposition);
        expect(
          (yield* fixture.store.recover()).positions[0]?.currentAnchorHash,
        ).toBe(proposal.anchorHash);
      }),
    ),
  );

/**
 * A peer's vote that arrives before the endpoint's own catch-up completes is
 * held and replayed once the position is ready, and the replay completes the
 * re-anchor without the peer voting again. Fails when a held vote is not
 * replayed, or when the endpoint still proposes its own re-anchor after the
 * replay completed it: that candidate no longer matches the durable position,
 * so the run reports a persistence failure.
 */
const replaysPeerVoteHeldBeforeCatchUpCompletes = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* retainCertifiedRecord(fixture);
        const outbound = yield* Queue.unbounded<SignedMessage>();
        const { recovery, request } = yield* startRestartRecovery(
          fixture,
          outbound,
        );

        const early = yield* peerReanchorVote(fixture).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* catchUpIncompleteIngress(fixture, request).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));
        const proposal = yield* Queue.take(outbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeReanchorVote),
        );

        expect(early).toBe(acceptedDisposition);
        expect(
          (yield* fixture.store.recover()).positions[0]?.currentAnchorHash,
        ).toBe(proposal.anchorHash);
      }),
    ),
  );

/**
 * A peer's re-anchor vote whose outer envelope is addressed beyond the
 * conversation's members fails the envelope's membership check, so it is
 * reported ignored and the run still takes the peer's genuine vote. Fails
 * when that check surfaces as a persistence failure, which ends the Router
 * worker's poll loop.
 */
const ignoresReanchorVoteAddressedBeyondItsMembers = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const { recovery, proposal } = yield* proposeAtRestart(fixture);
        const outsiderAuthority = yield* makeTestAuthority();
        const outsider = yield* issueTestCard({
          byte: 3,
          name: "recovery-outsider",
          authority: outsiderAuthority,
          registryKeys: fixture.registryKeys,
        });

        const misaddressed = yield* peerReanchorVoteIngressFrom({
          membership: {
            ...fixture.membership,
            members: [...fixture.membership.members, outsider],
          },
          responder: fixture.remote,
          proposal,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const genuine = yield* peerReanchorVoteIngress(fixture, proposal).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(misaddressed).toBe(ignoredDisposition);
        expect(genuine).toBe(acceptedDisposition);
      }),
    ),
  );

/**
 * A member's envelope carrying re-anchor vote evidence signed by an agent
 * outside the conversation passes the envelope check and fails the evidence
 * membership check, so it is reported ignored and the run still takes the
 * peer's genuine vote. Fails when the evidence check surfaces as a
 * persistence failure, which ends the Router worker's poll loop.
 */
const ignoresReanchorVoteWhoseEvidenceSignerIsNotAMember = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const { recovery, proposal } = yield* proposeAtRestart(fixture);
        const outsiderAuthority = yield* makeTestAuthority();
        const outsider = yield* issueTestCard({
          byte: 3,
          name: "recovery-outsider",
          authority: outsiderAuthority,
          registryKeys: fixture.registryKeys,
        });

        const forged = yield* peerReanchorVoteIngressFrom({
          membership: fixture.membership,
          responder: fixture.remote,
          proposal,
          routerInstanceId: newRouterInstanceId,
          evidenceSigner: { card: outsider, authority: outsiderAuthority },
        }).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const genuine = yield* peerReanchorVoteIngress(fixture, proposal).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(forged).toBe(ignoredDisposition);
        expect(genuine).toBe(acceptedDisposition);
      }),
    ),
  );

const rebroadcastsPersistedLocalVote = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* retainCertifiedRecord(fixture);
        const firstOutbound = yield* Queue.unbounded<SignedMessage>();
        const releaseRequest = yield* Deferred.make<undefined>();
        const voteSendStarted = yield* Deferred.make<undefined>();
        yield* fixture.engine.abandonVolatileFolds("router_restarted");
        const firstRecovery = yield* Effect.fork(
          fixture.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: {
              routerInstanceId: newRouterInstanceId,
              pollCursor,
            },
            resume: () => Effect.void,
            send: ({ message }) =>
              decodeOuterBody(message.body).pipe(
                Effect.orDie,
                Effect.flatMap((body) => {
                  if (
                    body.kind === "direct" &&
                    body.packet.kind === "catch_up_request"
                  ) {
                    return Queue.offer(firstOutbound, message).pipe(
                      Effect.zipRight(Deferred.await(releaseRequest)),
                      Effect.asVoid,
                    );
                  }
                  if (body.kind === "evidence") {
                    return Deferred.succeed(voteSendStarted, undefined).pipe(
                      Effect.zipRight(Effect.never),
                    );
                  }
                  return Effect.dieMessage(
                    "expected a catch-up request or local vote",
                  );
                }),
              ),
          }),
        );
        const firstRequest = yield* Queue.take(firstOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        yield* Deferred.succeed(releaseRequest, undefined);
        yield* catchUpIncompleteIngress(fixture, firstRequest).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Deferred.await(voteSendStarted).pipe(Effect.timeout("1 second"));
        expect(
          (yield* fixture.store.recover()).evidence.filter(
            (evidence) => evidence.kind === "reanchor",
          ),
        ).toHaveLength(1);
        yield* Fiber.interrupt(firstRecovery);

        const secondOutbound = yield* Queue.unbounded<SignedMessage>();
        const { recovery: secondRecovery, request: secondRequest } =
          yield* startRestartRecovery(fixture, secondOutbound);
        yield* catchUpIncompleteIngress(fixture, secondRequest).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const replayedVote = yield* Queue.take(secondOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeReanchorVote),
        );
        expect(replayedVote.signerAgentId).toBe(fixture.local.card.agentId);
        yield* Fiber.interrupt(secondRecovery);
      }),
    ),
  );

const rebroadcastsPersistedCompletedReanchor = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* retainCertifiedRecord(fixture);
        const { proposal } = yield* reanchorUntilCompletionSend(fixture);
        expect(
          (yield* fixture.store.recover()).positions[0]?.currentAnchorHash,
        ).toBe(proposal.anchorHash);

        const secondOutbound = yield* Queue.unbounded<SignedMessage>();
        const { recovery: secondRecovery, request: secondRequest } =
          yield* startRestartRecovery(fixture, secondOutbound);
        yield* catchUpIncompleteIngress(fixture, secondRequest).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const replayed = yield* Queue.take(secondOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap((message) => decodeOuterBody(message.body)),
        );
        expect(replayed).toMatchObject({
          kind: "direct",
          packet: {
            kind: "completed_reanchor",
            anchorHash: proposal.anchorHash,
          },
        });
        yield* Fiber.join(secondRecovery).pipe(Effect.timeout("1 second"));
      }),
    ),
  );

const recoversN4PartiallyDisseminatedSuccessor = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const n4 = yield* addN4Foundation(fixture);
        const history = yield* buildN4PartialHistory(fixture, n4);
        yield* directPacketIngressFrom({
          membership: n4.membership,
          sender: fixture.remote,
          packet: history.certifiedHead,
          routerInstanceId: oldRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRouterIngress(ingress)),
        );
        yield* directPacketIngressFrom({
          membership: n4.membership,
          sender: n4.fourth,
          packet: history.stagedSuccessor,
          routerInstanceId: oldRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRouterIngress(ingress)),
        );
        const before = yield* fixture.store.recover();
        expect(
          before.positions.find(
            ({ conversationId }) =>
              conversationId === n4.membership.descriptor.conversationId,
          )?.headRecordHash,
        ).toBe(history.certifiedHead.actionCertifiedRecord.recordHash);
        expect(
          before.stagedRecords.some(
            ({ recordHash }) =>
              recordHash === history.stagedSuccessor.recordHash,
          ),
        ).toBe(true);
        expect(
          before.certifiedRecords.some(
            ({ recordHash }) =>
              recordHash === history.stagedSuccessor.recordHash,
          ),
        ).toBe(false);
        expect(
          before.evidence.filter(
            ({ kind, subjectId }) =>
              kind === "durability" &&
              subjectId === history.stagedSuccessor.recordHash,
          ),
        ).toHaveLength(1);

        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        yield* n4.engine.abandonVolatileFolds("router_restarted");
        const recovering = yield* Effect.fork(
          n4.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: {
              routerInstanceId: newRouterInstanceId,
              pollCursor,
            },
            resume: (outboundId) =>
              forwardStoredOutbound(
                fixture.store,
                recoveryOutbound,
                outboundId,
              ),
            send: ({ message }) =>
              Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const firstRequest = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        const secondRequest = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        const directRequest = [firstRequest, secondRequest].find(
          (request) =>
            request.conversationId ===
            fixture.membership.descriptor.conversationId,
        );
        const n4Request = [firstRequest, secondRequest].find(
          (request) =>
            request.conversationId === n4.membership.descriptor.conversationId,
        );
        if (directRequest === undefined || n4Request === undefined) {
          return yield* Effect.dieMessage(
            "recovery did not request both conversation positions",
          );
        }
        yield* catchUpIncompleteIngressFrom({
          membership: fixture.membership,
          responder: fixture.remote,
          request: directRequest,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        yield* catchUpIncompleteIngressFrom({
          membership: n4.membership,
          responder: fixture.remote,
          request: n4Request,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        yield* catchUpIncompleteIngressFrom({
          membership: n4.membership,
          responder: n4.third,
          request: n4Request,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        const beforeCompleteSource = yield* fixture.store.recover();
        expect(
          beforeCompleteSource.stagedReanchors.filter(
            ({ conversationId }) =>
              conversationId === n4.membership.descriptor.conversationId,
          ),
        ).toHaveLength(0);
        expect(
          beforeCompleteSource.evidence.filter(
            ({ conversationId, kind }) =>
              conversationId === n4.membership.descriptor.conversationId &&
              kind === "reanchor",
          ),
        ).toHaveLength(0);
        expect(Option.isNone(yield* Queue.poll(recoveryOutbound))).toBe(true);

        yield* catchUpRecordIngressFrom({
          membership: n4.membership,
          responder: n4.fourth,
          request: n4Request,
          record: history.certifiedSuccessor,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        const advancedRequest = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        expect(advancedRequest).toMatchObject({
          conversationId: n4.membership.descriptor.conversationId,
          knownRecordHash: history.stagedSuccessor.recordHash,
          knownAnchorHash: history.stagedSuccessor.recordCore.anchorHash,
        });
        const afterCompleteSource = yield* fixture.store.recover();
        expect(
          afterCompleteSource.positions.find(
            ({ conversationId }) =>
              conversationId === n4.membership.descriptor.conversationId,
          )?.headRecordHash,
        ).toBe(history.stagedSuccessor.recordHash);
        expect(
          afterCompleteSource.certifiedRecords.some(
            ({ recordHash }) =>
              recordHash === history.stagedSuccessor.recordHash,
          ),
        ).toBe(true);

        yield* catchUpIncompleteIngressFrom({
          membership: n4.membership,
          responder: fixture.remote,
          request: advancedRequest,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        yield* catchUpIncompleteIngressFrom({
          membership: n4.membership,
          responder: n4.third,
          request: advancedRequest,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        yield* catchUpIncompleteIngressFrom({
          membership: n4.membership,
          responder: n4.fourth,
          request: advancedRequest,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        const proposal = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeReanchorVote),
        );
        expect(proposal.reanchor.selectedRecordHash).toBe(
          history.stagedSuccessor.recordHash,
        );
        yield* peerReanchorVoteIngressFrom({
          membership: n4.membership,
          responder: fixture.remote,
          proposal,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        yield* peerReanchorVoteIngressFrom({
          membership: n4.membership,
          responder: n4.third,
          proposal,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        const completed = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap((message) => decodeOuterBody(message.body)),
        );
        expect(completed).toMatchObject({
          kind: "direct",
          packet: {
            kind: "completed_reanchor",
            anchorHash: proposal.anchorHash,
          },
        });

        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));
        const recovered = yield* fixture.store.recover();
        expect(
          recovered.positions.find(
            ({ conversationId }) =>
              conversationId === n4.membership.descriptor.conversationId,
          ),
        ).toMatchObject({
          headRecordHash: history.stagedSuccessor.recordHash,
          currentAnchorHash: proposal.anchorHash,
        });
      }),
    ),
  );

const blocksN4ReanchorBehindStagedSuccessor = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const n4 = yield* addN4Foundation(fixture);
        const history = yield* buildN4PartialHistory(fixture, n4);
        yield* directPacketIngressFrom({
          membership: n4.membership,
          sender: fixture.remote,
          packet: history.certifiedHead,
          routerInstanceId: oldRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRouterIngress(ingress)),
        );
        yield* directPacketIngressFrom({
          membership: n4.membership,
          sender: n4.fourth,
          packet: history.stagedSuccessor,
          routerInstanceId: oldRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRouterIngress(ingress)),
        );

        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        yield* n4.engine.abandonVolatileFolds("router_restarted");
        const recovering = yield* Effect.fork(
          n4.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: {
              routerInstanceId: newRouterInstanceId,
              pollCursor,
            },
            resume: (outboundId) =>
              forwardStoredOutbound(
                fixture.store,
                recoveryOutbound,
                outboundId,
              ),
            send: ({ message }) =>
              Queue.offer(recoveryOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const firstRequest = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        const secondRequest = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        const directRequest = [firstRequest, secondRequest].find(
          (request) =>
            request.conversationId ===
            fixture.membership.descriptor.conversationId,
        );
        const n4Request = [firstRequest, secondRequest].find(
          (request) =>
            request.conversationId === n4.membership.descriptor.conversationId,
        );
        if (directRequest === undefined || n4Request === undefined) {
          return yield* Effect.dieMessage(
            "recovery did not request both conversation positions",
          );
        }
        yield* catchUpIncompleteIngressFrom({
          membership: fixture.membership,
          responder: fixture.remote,
          request: directRequest,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        yield* catchUpIncompleteIngressFrom({
          membership: n4.membership,
          responder: fixture.remote,
          request: n4Request,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        yield* catchUpIncompleteIngressFrom({
          membership: n4.membership,
          responder: n4.third,
          request: n4Request,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );
        yield* catchUpIncompleteIngressFrom({
          membership: n4.membership,
          responder: n4.fourth,
          request: n4Request,
          routerInstanceId: newRouterInstanceId,
        }).pipe(
          Effect.flatMap((ingress) => n4.engine.acceptRecoveryIngress(ingress)),
        );

        const blocked = yield* fixture.store.recover();
        expect(
          blocked.stagedReanchors.filter(
            ({ conversationId }) =>
              conversationId === n4.membership.descriptor.conversationId,
          ),
        ).toHaveLength(0);
        expect(
          blocked.evidence.filter(
            ({ conversationId, kind }) =>
              conversationId === n4.membership.descriptor.conversationId &&
              kind === "reanchor",
          ),
        ).toHaveLength(0);
        expect(Option.isNone(yield* Queue.poll(recoveryOutbound))).toBe(true);
        expect(Option.isNone(yield* Fiber.poll(recovering))).toBe(true);
        yield* Fiber.interrupt(recovering);
      }),
    ),
  );

// @agent-code-guard/regression-only: these traces pin restart liveness and fail-closed ancestry handling.
describe("endpoint restart recovery", () => {
  it(
    "completes recovery before a held normal send resumes",
    recoverWhileNormalSendIsHeld,
  );
  it(
    "recovers certificates when encoded and canonical AgentId orders differ",
    restartWithNonLexicalAgentOrder,
  );
  it(
    "waits for the complete N4 successor before re-anchoring its latest head",
    recoversN4PartiallyDisseminatedSuccessor,
  );
  it(
    "does not re-anchor behind a staged N4 successor when every peer reports incomplete",
    blocksN4ReanchorBehindStagedSuccessor,
  );
  it(
    "rebroadcasts a persisted local vote after an interrupted send",
    rebroadcastsPersistedLocalVote,
  );
  it(
    "rebroadcasts a persisted completed re-anchor after an interrupted send",
    rebroadcastsPersistedCompletedReanchor,
  );
  it(
    "re-anchors, requeues retained evidence, and resumes normal sends",
    completeRestartRecovery,
  );
  it(
    "discards an old-instance POST and reproposes the same PostId at the new anchor",
    reproposesPendingPostAfterRestart,
  );
  it(
    "restarts an empty foundation at the new Router instance",
    restartEmptyConversation,
  );
  it("resumes a same-instance persisted intent without reproposing", () =>
    recoverSameRouterInstance("feed_gap"));
  it("preserves retained envelope bytes when startup finds the same Router", () =>
    recoverSameRouterInstance("router_restarted"));
  it(
    "catches up without re-anchoring when a cold start finds the anchored Router instance",
    recoverColdStartAtUnchangedInstance,
  );
  it(
    "re-anchors only the conversation anchored to another Router instance",
    recoverMixedRouterInstances,
  );
  it(
    "finishes recovery while an outbound drain waits on the recovering worker",
    recoverWhileDrainAwaitsWorker,
  );
  it(
    "rebuilds one discarded record dissemination without duplication",
    recoverDisseminationObligations,
  );
  it(
    "ignores a re-anchor vote during a feed_gap recovery",
    ignoresReanchorVoteDuringFeedGapRecovery,
  );
  it(
    "ignores a re-anchor vote that arrives after recovery completes",
    ignoresReanchorVoteAfterRecovery,
  );
  it(
    "ignores a relayed completed re-anchor for a conversation already anchored at the new Router",
    ignoresRelayedCompletionForAnchoredConversation,
  );
  it(
    "adopts a relayed completed re-anchor for a conversation it is re-anchoring",
    adoptsRelayedCompletionForReanchoringConversation,
  );
  it(
    "ignores a re-anchor vote whose anchor hash its body does not hash to",
    ignoresReanchorVoteWithMismatchedAnchorHash,
  );
  it(
    "ignores a re-anchor vote whose envelope is addressed beyond its members",
    ignoresReanchorVoteAddressedBeyondItsMembers,
  );
  it(
    "ignores a re-anchor vote whose evidence an agent outside the conversation signed",
    ignoresReanchorVoteWhoseEvidenceSignerIsNotAMember,
  );
  it(
    "replays a peer's re-anchor vote held from before its catch-up completed",
    replaysPeerVoteHeldBeforeCatchUpCompletes,
  );
});

// @agent-code-guard/regression-only: these traces pin outbound drain order and gate release.
describe("endpoint outbound drain", () => {
  it(
    "sends each queued envelope once, in order, across concurrent drains",
    concurrentDrainsSendOnceInOrder,
  );
  it(
    "keeps a later head when another drain removed the one it sent",
    staleDrainKeepsLaterHead,
  );
  it(
    "completes Router recovery that runs on the draining fiber",
    drainRecoversRouterRestartOnItsOwnFiber,
  );
});

/**
 * Starts a recovery of `engine` at `routerInstanceId`; every envelope the run
 * sends lands in the returned queue.
 * @param engine Endpoint under recovery.
 * @param reason Discontinuity that started the recovery.
 * @param routerInstanceId Router instance the recovery anchors to.
 * @returns The running recovery and the queue of envelopes it sent.
 */
const forkRecovery = (
  engine: EndpointEngine,
  reason: RouterDiscontinuityReason,
  routerInstanceId: typeof RouterInstanceId.Type,
) =>
  Effect.gen(function* () {
    const outbound = yield* Queue.unbounded<SignedMessage>();
    yield* engine.abandonVolatileFolds(reason);
    const recovery = yield* Effect.fork(
      engine.recoverCertifiedHistory({
        reason,
        anchor: { routerInstanceId, pollCursor },
        resume: () => Effect.void,
        send: ({ message }) =>
          Queue.offer(outbound, message).pipe(Effect.asVoid),
      }),
    );
    return { recovery, outbound };
  });

/**
 * Accepts one ingress through the engine's recovery path, as the Router
 * worker does while a recovery runs.
 * @param engine Endpoint receiving the ingress.
 * @param ingress The ingress to deliver.
 * @returns How the engine disposed of the ingress.
 */
const deliverRecovery = (
  engine: EndpointEngine,
  ingress: Effect.Effect<RouterWorkerIngress<DecodedOuterBody>>,
) =>
  ingress.pipe(Effect.flatMap((value) => engine.acceptRecoveryIngress(value)));

/**
 * The peer's correctly signed vote for `reanchor`, naming the anchor hash its
 * body hashes to.
 * @param fixture Endpoint the vote is addressed to.
 * @param reanchor Re-anchor body the peer votes for.
 * @returns The vote as recovery ingress.
 */
const peerVoteFor = (fixture: RecoveryFixture, reanchor: ReanchorBody) =>
  hashAnchor(reanchor).pipe(
    Effect.orDie,
    Effect.flatMap((anchorHash) =>
      peerReanchorVoteIngress(fixture, {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "reanchor_vote",
        signerAgentId: fixture.remote.card.agentId,
        anchorHash,
        reanchor,
      }),
    ),
  );

/**
 * Takes the two catch-up requests a recovery of the N4 engine sends first.
 * @param fixture Endpoint whose direct conversation is one of the two.
 * @param n4 Engine whose N4 conversation is the other.
 * @param outbound Queue the recovery sends to.
 * @returns The request for each conversation.
 */
const takeN4Requests = (
  fixture: RecoveryFixture,
  n4: N4Foundation,
  outbound: Queue.Queue<SignedMessage>,
) =>
  Effect.gen(function* () {
    const first = yield* Queue.take(outbound).pipe(
      Effect.timeout("1 second"),
      Effect.flatMap(decodeCatchUpRequest),
    );
    const second = yield* Queue.take(outbound).pipe(
      Effect.timeout("1 second"),
      Effect.flatMap(decodeCatchUpRequest),
    );
    const direct = [first, second].find(
      (request) =>
        request.conversationId === fixture.membership.descriptor.conversationId,
    );
    const group = [first, second].find(
      (request) =>
        request.conversationId === n4.membership.descriptor.conversationId,
    );
    if (direct === undefined || group === undefined) {
      return yield* Effect.dieMessage(
        "recovery did not request both conversation positions",
      );
    }
    return { direct, group };
  });

/**
 * The hash of the GENESIS anchor a restart gives the fixture's direct
 * conversation when it restarts it empty at the new Router instance.
 * @param fixture Endpoint whose direct conversation restarts.
 * @returns The replacement anchor's hash.
 */
const restartedDirectAnchorHash = (fixture: RecoveryFixture) => {
  const anchor: GenesisAnchorBody = {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "genesis_anchor_body",
    conversationId: fixture.membership.descriptor.conversationId,
    membershipHash: fixture.membership.hash,
    routerInstanceId: newRouterInstanceId,
  };
  return hashAnchor(anchor).pipe(Effect.orDie);
};

/**
 * The durable anchor of the fixture's direct conversation.
 * @param fixture Endpoint whose store is read.
 * @returns The direct conversation's current anchor hash.
 */
const directAnchorHash = (fixture: RecoveryFixture) =>
  fixture.store
    .recover()
    .pipe(
      Effect.map(
        (recovered) =>
          recovered.positions.find(
            ({ conversationId }) =>
              conversationId === fixture.membership.descriptor.conversationId,
          )?.currentAnchorHash,
      ),
    );

/**
 * Re-anchors the N4 conversation at its certified head after a restart: the
 * endpoint stages its candidate and sends its vote, while the direct
 * conversation restarts empty. A certified successor then arrives as recovery
 * traffic, which moves the head past the staged candidate, and the run asks
 * for the history after the new head.
 * @param fixture Endpoint owning the direct conversation.
 * @param n4 Engine holding both conversations.
 * @returns The running recovery, its queue, the staged vote, the successor's
 *     disposition, and the request at the new head.
 */
const advanceN4HeadPastStagedCandidate = (
  fixture: RecoveryFixture,
  n4: N4Foundation,
) =>
  Effect.gen(function* () {
    const history = yield* buildN4PartialHistory(fixture, n4);
    yield* directPacketIngressFrom({
      membership: n4.membership,
      sender: fixture.remote,
      packet: history.certifiedHead,
      routerInstanceId: oldRouterInstanceId,
    }).pipe(
      Effect.flatMap((ingress) => n4.engine.acceptRouterIngress(ingress)),
    );
    const { recovery, outbound } = yield* forkRecovery(
      n4.engine,
      "router_restarted",
      newRouterInstanceId,
    );
    const requests = yield* takeN4Requests(fixture, n4, outbound);
    yield* deliverRecovery(
      n4.engine,
      catchUpIncompleteIngressFrom({
        membership: fixture.membership,
        responder: fixture.remote,
        request: requests.direct,
        routerInstanceId: newRouterInstanceId,
      }),
    );
    yield* deliverRecovery(
      n4.engine,
      catchUpIncompleteIngressFrom({
        membership: n4.membership,
        responder: fixture.remote,
        request: requests.group,
        routerInstanceId: newRouterInstanceId,
      }),
    );
    yield* deliverRecovery(
      n4.engine,
      catchUpIncompleteIngressFrom({
        membership: n4.membership,
        responder: n4.third,
        request: requests.group,
        routerInstanceId: newRouterInstanceId,
      }),
    );
    yield* deliverRecovery(
      n4.engine,
      catchUpIncompleteIngressFrom({
        membership: n4.membership,
        responder: n4.fourth,
        request: requests.group,
        routerInstanceId: newRouterInstanceId,
      }),
    );
    const staged = yield* Queue.take(outbound).pipe(
      Effect.timeout("1 second"),
      Effect.flatMap(decodeReanchorVote),
    );
    const successor = yield* deliverRecovery(
      n4.engine,
      directPacketIngressFrom({
        membership: n4.membership,
        sender: n4.fourth,
        packet: history.certifiedSuccessor,
        routerInstanceId: newRouterInstanceId,
      }),
    );
    const advancedRequest = yield* Queue.take(outbound).pipe(
      Effect.timeout("1 second"),
      Effect.flatMap(decodeCatchUpRequest),
    );
    return { recovery, outbound, history, staged, successor, advancedRequest };
  });

/**
 * A peer's vote whose previous anchor is neither this endpoint's anchor nor
 * one of its ancestors is reported ignored, and the peer's genuine vote still
 * completes the re-anchor. Fails when that vote ends recovery with a
 * persistence failure, which ends the Router worker's poll loop.
 */
const ignoresReanchorVoteFromUnknownPreviousAnchor = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const { recovery, proposal } = yield* proposeAtRestart(fixture);
        const unknownAnchorHash = yield* hashAnchor({
          ...proposal.reanchor,
          routerInstanceId: oldRouterInstanceId,
        });

        const unresolvable = yield* deliverRecovery(
          fixture.engine,
          peerVoteFor(fixture, {
            ...proposal.reanchor,
            previousAnchorHash: unknownAnchorHash,
          }),
        );
        const genuine = yield* deliverRecovery(
          fixture.engine,
          peerReanchorVoteIngress(fixture, proposal),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(unresolvable).toBe(ignoredDisposition);
        expect(genuine).toBe(acceptedDisposition);
        expect(
          (yield* fixture.store.recover()).positions[0]?.currentAnchorHash,
        ).toBe(proposal.anchorHash);
      }),
    ),
  );

/**
 * Once the endpoint has staged its candidate, a peer's vote selecting a
 * record this endpoint does not hold is reported ignored, and the peer's
 * genuine vote still completes the re-anchor. Fails when that vote ends
 * recovery with a persistence failure.
 */
const ignoresReanchorVoteForUnknownHeadOnceStaged = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const { recovery, proposal } = yield* proposeAtRestart(fixture);
        const unknown = yield* buildCertifiedGenesis(
          fixture.local,
          fixture.remote,
          fixture.membership,
        );

        const unresolvable = yield* deliverRecovery(
          fixture.engine,
          peerVoteFor(fixture, {
            ...proposal.reanchor,
            selectedRecordHash: unknown.actionCertifiedRecord.recordHash,
          }),
        );
        const genuine = yield* deliverRecovery(
          fixture.engine,
          peerReanchorVoteIngress(fixture, proposal),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(unresolvable).toBe(ignoredDisposition);
        expect(genuine).toBe(acceptedDisposition);
        expect(
          (yield* fixture.store.recover()).positions[0]?.currentAnchorHash,
        ).toBe(proposal.anchorHash);
      }),
    ),
  );

/**
 * A peer's vote held before catch-up completes selects a record that catch-up
 * never supplies. When the position is ready that vote does not count: the
 * endpoint proposes at its own head and the peer's genuine vote completes the
 * re-anchor. Fails when the unresolved held vote ends recovery with a
 * persistence failure at position-ready.
 */
const reanchorsPastHeldVoteForUnsuppliedHead = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* retainCertifiedRecord(fixture);
        const { recordCore, recordHash } =
          fixture.certifiedRecord.actionCertifiedRecord;
        const unknown = yield* buildCertifiedGenesis(
          fixture.local,
          fixture.remote,
          fixture.membership,
        );
        const { recovery, outbound } = yield* forkRecovery(
          fixture.engine,
          "router_restarted",
          newRouterInstanceId,
        );
        const request = yield* Queue.take(outbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );

        const held = yield* deliverRecovery(
          fixture.engine,
          peerVoteFor(fixture, {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "reanchor_body",
            conversationId: recordCore.action.conversationId,
            membershipHash: fixture.membership.hash,
            previousAnchorHash: recordCore.anchorHash,
            selectedRecordHash: unknown.actionCertifiedRecord.recordHash,
            routerInstanceId: newRouterInstanceId,
          }),
        );
        const ready = yield* deliverRecovery(
          fixture.engine,
          catchUpIncompleteIngress(fixture, request),
        );
        const proposal = yield* Queue.take(outbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeReanchorVote),
        );
        const genuine = yield* deliverRecovery(
          fixture.engine,
          peerReanchorVoteIngress(fixture, proposal),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(held).toBe(acceptedDisposition);
        expect(ready).toBe(acceptedDisposition);
        expect(proposal.reanchor.selectedRecordHash).toBe(recordHash);
        expect(genuine).toBe(acceptedDisposition);
        expect(
          (yield* fixture.store.recover()).positions[0]?.currentAnchorHash,
        ).toBe(proposal.anchorHash);
      }),
    ),
  );

/**
 * After the run restarts the direct conversation's empty foundation, a peer's
 * vote for it has no head to re-anchor, so it is reported ignored and the run
 * still recovers the N4 conversation. Fails when the vote ends recovery with
 * a persistence failure.
 */
const ignoresReanchorVoteForRestartedEmptyConversation = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const n4 = yield* addN4Foundation(fixture);
        const { recovery, outbound } = yield* forkRecovery(
          n4.engine,
          "router_restarted",
          newRouterInstanceId,
        );
        const requests = yield* takeN4Requests(fixture, n4, outbound);
        yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: fixture.membership,
            responder: fixture.remote,
            request: requests.direct,
            routerInstanceId: newRouterInstanceId,
          }),
        );

        const vote = yield* deliverRecovery(
          n4.engine,
          peerReanchorVote(fixture),
        );
        yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: n4.membership,
            responder: fixture.remote,
            request: requests.group,
            routerInstanceId: newRouterInstanceId,
          }),
        );
        yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: n4.membership,
            responder: n4.third,
            request: requests.group,
            routerInstanceId: newRouterInstanceId,
          }),
        );
        yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: n4.membership,
            responder: n4.fourth,
            request: requests.group,
            routerInstanceId: newRouterInstanceId,
          }),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(vote).toBe(ignoredDisposition);
        expect(yield* directAnchorHash(fixture)).toBe(
          yield* restartedDirectAnchorHash(fixture),
        );
      }),
    ),
  );

/**
 * After the run restarts the direct conversation's empty foundation, a
 * relayed completed re-anchor for it has no head to re-anchor, so it is
 * reported ignored and the run still recovers the N4 conversation. Fails when
 * the completion ends recovery with a persistence failure, or is reported
 * accepted although the run took none of its votes.
 */
const ignoresRelayedCompletionForRestartedEmptyConversation = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const n4 = yield* addN4Foundation(fixture);
        const { recordCore, recordHash } =
          fixture.certifiedRecord.actionCertifiedRecord;
        const reanchor: ReanchorBody = {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "reanchor_body",
          conversationId: recordCore.action.conversationId,
          membershipHash: fixture.membership.hash,
          previousAnchorHash: recordCore.anchorHash,
          selectedRecordHash: recordHash,
          routerInstanceId: newRouterInstanceId,
        };
        const anchorHash = yield* hashAnchor(reanchor);
        const localVote = yield* encodedEvidence(fixture.local, {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "reanchor_vote",
          signerAgentId: fixture.local.card.agentId,
          anchorHash,
          reanchor,
        });
        const peerVote = yield* encodedEvidence(fixture.remote, {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "reanchor_vote",
          signerAgentId: fixture.remote.card.agentId,
          anchorHash,
          reanchor,
        });
        const completed: DirectPacket = {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "completed_reanchor",
          anchorHash,
          reanchor,
          certificate: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "reanchor_certificate",
            anchorHash,
            votes: [localVote, peerVote],
          },
        };
        const { recovery, outbound } = yield* forkRecovery(
          n4.engine,
          "router_restarted",
          newRouterInstanceId,
        );
        const requests = yield* takeN4Requests(fixture, n4, outbound);
        yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: fixture.membership,
            responder: fixture.remote,
            request: requests.direct,
            routerInstanceId: newRouterInstanceId,
          }),
        );

        const relayed = yield* deliverRecovery(
          n4.engine,
          directPacketIngressFrom({
            membership: fixture.membership,
            sender: fixture.remote,
            packet: completed,
            routerInstanceId: newRouterInstanceId,
          }),
        );
        yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: n4.membership,
            responder: fixture.remote,
            request: requests.group,
            routerInstanceId: newRouterInstanceId,
          }),
        );
        yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: n4.membership,
            responder: n4.third,
            request: requests.group,
            routerInstanceId: newRouterInstanceId,
          }),
        );
        yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: n4.membership,
            responder: n4.fourth,
            request: requests.group,
            routerInstanceId: newRouterInstanceId,
          }),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(relayed).toBe(ignoredDisposition);
        expect(yield* directAnchorHash(fixture)).toBe(
          yield* restartedDirectAnchorHash(fixture),
        );
      }),
    ),
  );

/**
 * A second catch-up page for an already answered request, carrying a
 * different certified successor, is reported ignored; the first successor
 * stays the head and catch-up completes from it. Fails when the conflicting
 * page ends recovery with a persistence failure.
 */
const ignoresCatchUpPageWithConflictingSuccessor = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const conflicting = yield* buildCertifiedGenesis(
          fixture.local,
          fixture.remote,
          fixture.membership,
        );
        const { recovery, outbound } = yield* forkRecovery(
          fixture.engine,
          "feed_gap",
          oldRouterInstanceId,
        );
        const first = yield* Queue.take(outbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        const applied = yield* deliverRecovery(
          fixture.engine,
          catchUpRecordIngressFrom({
            membership: fixture.membership,
            responder: fixture.remote,
            request: first,
            record: fixture.certifiedRecord,
            routerInstanceId: oldRouterInstanceId,
          }),
        );
        const next = yield* Queue.take(outbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );

        const conflict = yield* deliverRecovery(
          fixture.engine,
          catchUpRecordIngressFrom({
            membership: fixture.membership,
            responder: fixture.remote,
            request: first,
            record: conflicting,
            routerInstanceId: oldRouterInstanceId,
          }),
        );
        const complete = yield* deliverRecovery(
          fixture.engine,
          catchUpIncompleteIngressFrom({
            membership: fixture.membership,
            responder: fixture.remote,
            request: next,
            routerInstanceId: oldRouterInstanceId,
          }),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(applied).toBe(acceptedDisposition);
        expect(conflict).toBe(ignoredDisposition);
        expect(complete).toBe(acceptedDisposition);
        expect(
          (yield* fixture.store.recover()).positions[0]?.headRecordHash,
        ).toBe(fixture.certifiedRecord.actionCertifiedRecord.recordHash);
      }),
    ),
  );

/**
 * A catch-up page whose verified GENESIS record binds another Router
 * instance's anchor does not extend the conversation, so it is reported
 * ignored and catch-up completes at the empty position. Fails when the page
 * ends recovery with a persistence failure.
 */
const ignoresCatchUpPageWhoseRecordDoesNotExtendTheConversation = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const elsewhere = yield* buildCertifiedGenesis(
          fixture.local,
          fixture.remote,
          fixture.membership,
          newRouterInstanceId,
        );
        const { recovery, outbound } = yield* forkRecovery(
          fixture.engine,
          "feed_gap",
          oldRouterInstanceId,
        );
        const request = yield* Queue.take(outbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );

        const page = yield* deliverRecovery(
          fixture.engine,
          catchUpRecordIngressFrom({
            membership: fixture.membership,
            responder: fixture.remote,
            request,
            record: elsewhere,
            routerInstanceId: oldRouterInstanceId,
          }),
        );
        const complete = yield* deliverRecovery(
          fixture.engine,
          catchUpIncompleteIngressFrom({
            membership: fixture.membership,
            responder: fixture.remote,
            request,
            routerInstanceId: oldRouterInstanceId,
          }),
        );
        yield* Fiber.join(recovery).pipe(Effect.timeout("1 second"));

        expect(page).toBe(ignoredDisposition);
        expect(complete).toBe(acceptedDisposition);
        expect(
          (yield* fixture.store.recover()).positions[0]?.headRecordHash,
        ).toBeUndefined();
      }),
    ),
  );

/**
 * The Router worker polls recovery traffic while the recovery run is still
 * starting. A certified record delivered before the run exists is applied
 * and reported accepted, and the run then catches up from it. Fails when the
 * missing run ends recovery with a persistence failure.
 */
const acceptsCertifiedRecordBeforeTheRunStarts = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* fixture.engine.abandonVolatileFolds("feed_gap");

        const early = yield* deliverRecovery(
          fixture.engine,
          certifiedRecordIngress(fixture),
        );
        yield* runSameInstanceRecovery(fixture, "feed_gap", Effect.void);

        expect(early).toBe(acceptedDisposition);
        expect(
          (yield* fixture.store.recover()).positions[0]?.headRecordHash,
        ).toBe(fixture.certifiedRecord.actionCertifiedRecord.recordHash);
      }),
    ),
  );

/**
 * The endpoint staged its candidate at the N4 head, and a certified
 * successor then moved the head. A peer's vote at the new head would need a
 * second candidate for the same anchor and Router instance, which the
 * endpoint never stages, so the vote is reported ignored; the direct
 * conversation is still recovered and the run keeps running. Fails when the
 * vote ends recovery with a persistence failure.
 */
const ignoresReanchorVotePastTheStagedCandidate = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const n4 = yield* addN4Foundation(fixture);
        const { recovery, history, staged, successor } =
          yield* advanceN4HeadPastStagedCandidate(fixture, n4);
        const atNewHead: ReanchorBody = {
          ...staged.reanchor,
          selectedRecordHash:
            history.certifiedSuccessor.actionCertifiedRecord.recordHash,
        };

        const vote = yield* deliverRecovery(
          n4.engine,
          peerReanchorVoteIngressFrom({
            membership: n4.membership,
            responder: fixture.remote,
            proposal: {
              ...staged,
              anchorHash: yield* hashAnchor(atNewHead),
              reanchor: atNewHead,
            },
            routerInstanceId: newRouterInstanceId,
          }),
        );

        expect(successor).toBe(acceptedDisposition);
        expect(vote).toBe(ignoredDisposition);
        expect(yield* directAnchorHash(fixture)).toBe(
          yield* restartedDirectAnchorHash(fixture),
        );
        expect(Option.isNone(yield* Fiber.poll(recovery))).toBe(true);
        yield* Fiber.interrupt(recovery);
      }),
    ),
  );

/**
 * The endpoint staged its candidate at the N4 head, and a certified
 * successor then moved the head. When every peer reports nothing after the
 * new head, the endpoint does not stage or sign a second candidate for the
 * same anchor and Router instance: that conversation waits, the direct
 * conversation is recovered, and the run keeps running. Fails when the
 * position-ready step ends recovery with a persistence failure.
 */
const keepsOneCandidateAfterTheHeadMovesPastIt = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const n4 = yield* addN4Foundation(fixture);
        const { recovery, outbound, successor, advancedRequest } =
          yield* advanceN4HeadPastStagedCandidate(fixture, n4);

        yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: n4.membership,
            responder: fixture.remote,
            request: advancedRequest,
            routerInstanceId: newRouterInstanceId,
          }),
        );
        yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: n4.membership,
            responder: n4.third,
            request: advancedRequest,
            routerInstanceId: newRouterInstanceId,
          }),
        );
        const ready = yield* deliverRecovery(
          n4.engine,
          catchUpIncompleteIngressFrom({
            membership: n4.membership,
            responder: n4.fourth,
            request: advancedRequest,
            routerInstanceId: newRouterInstanceId,
          }),
        );

        expect(successor).toBe(acceptedDisposition);
        expect(ready).toBe(acceptedDisposition);
        expect(Option.isNone(yield* Queue.poll(outbound))).toBe(true);
        expect(yield* directAnchorHash(fixture)).toBe(
          yield* restartedDirectAnchorHash(fixture),
        );
        expect(Option.isNone(yield* Fiber.poll(recovery))).toBe(true);
        yield* Fiber.interrupt(recovery);
      }),
    ),
  );

/** The general JWS shape a signed message encodes to. */
const encodedSignedMessage = Schema.Struct({
  payload: Schema.String,
  signatures: Schema.Tuple(
    Schema.Struct({ protected: Schema.String, signature: Schema.String }),
  ),
});

/**
 * The canonical bytes of `message` with one byte of its signature flipped:
 * the same statement under a different signature.
 * @param message Signed evidence message to alter.
 * @returns Canonical bytes a store row holds for the altered message.
 */
const differentlySignedEvidence = (message: SignedMessage) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encode(SignedMessage)(message).pipe(
      Effect.flatMap(Schema.decodeUnknown(encodedSignedMessage)),
    );
    const [signed] = encoded.signatures;
    const signature = Buffer.from(signed.signature, "base64url");
    signature.writeUInt8((signature.readUInt8(0) + 1) % 256, 0);
    const altered = yield* Schema.decodeUnknown(SignedMessage)({
      ...encoded,
      signatures: [{ ...signed, signature: signature.toString("base64url") }],
    });
    return yield* encodeCanonical(SignedMessage, altered);
  }).pipe(Effect.orDie);

/**
 * A member's re-anchor vote whose evidence key already holds a different copy
 * of the same vote does not count: it is reported ignored and the run keeps
 * running. The row seeded through the store's public `mergeEvidence` stands
 * in for an earlier, differently signed copy of that vote, which a member can
 * produce because one statement has more than one valid signature. Fails
 * when the store's conflict on that key ends recovery with a persistence
 * failure.
 */
const ignoresReanchorVoteConflictingWithAStoredCopy = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const { recovery, proposal } = yield* proposeAtRestart(fixture);
        const peerVote = yield* signEvidenceMessage({
          statement: {
            ...proposal,
            signerAgentId: fixture.remote.card.agentId,
          },
          agentCard: fixture.remote.card,
          signingAuthority: fixture.remote.authority,
        });
        yield* fixture.store.mergeEvidence({
          conversationId: proposal.reanchor.conversationId,
          kind: "reanchor",
          subjectId: proposal.anchorHash,
          evidenceKey: fixture.remote.card.agentId,
          canonicalEvidence: yield* differentlySignedEvidence(peerVote),
        });

        const vote = yield* deliverRecovery(
          fixture.engine,
          peerReanchorVoteIngress(fixture, proposal),
        );

        expect(vote).toBe(ignoredDisposition);
        expect(Option.isNone(yield* Fiber.poll(recovery))).toBe(true);
        yield* Fiber.interrupt(recovery);
      }),
    ),
  );

// @agent-code-guard/regression-only: these traces pin that input from a peer never ends a recovery run.
describe("peer input during recovery", () => {
  it(
    "ignores a re-anchor vote whose previous anchor this endpoint cannot resolve",
    ignoresReanchorVoteFromUnknownPreviousAnchor,
  );
  it(
    "ignores a re-anchor vote for an unknown head once a candidate is staged",
    ignoresReanchorVoteForUnknownHeadOnceStaged,
  );
  it(
    "re-anchors at its own head past a held vote for a head catch-up never supplied",
    reanchorsPastHeldVoteForUnsuppliedHead,
  );
  it(
    "ignores a re-anchor vote for a conversation restarted empty",
    ignoresReanchorVoteForRestartedEmptyConversation,
  );
  it(
    "ignores a relayed completed re-anchor for a conversation restarted empty",
    ignoresRelayedCompletionForRestartedEmptyConversation,
  );
  it(
    "ignores a catch-up page whose successor conflicts with one already applied",
    ignoresCatchUpPageWithConflictingSuccessor,
  );
  it(
    "ignores a catch-up page whose record does not extend the conversation",
    ignoresCatchUpPageWhoseRecordDoesNotExtendTheConversation,
  );
  it(
    "accepts a certified record delivered before the recovery run starts",
    acceptsCertifiedRecordBeforeTheRunStarts,
  );
  it(
    "ignores a re-anchor vote at a head past the staged candidate",
    ignoresReanchorVotePastTheStagedCandidate,
  );
  it(
    "keeps one candidate after a certified successor moves the head past it",
    keepsOneCandidateAfterTheHeadMovesPastIt,
  );
  it(
    "ignores a re-anchor vote that conflicts with a stored copy of the same vote",
    ignoresReanchorVoteConflictingWithAStoredCopy,
  );
});

/* eslint-enable max-lines, max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- Restore repository defaults. */
