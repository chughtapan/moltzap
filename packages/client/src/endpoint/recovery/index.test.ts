/** @file Restart catch-up and threshold re-anchor tests for the addressed engine. */

import type { RegistryLookupResult } from "@moltzap/identity/registry";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  AgentCard,
  AgentId,
  AgentName,
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
  PrincipalId,
  SignedMessage,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { PollCursor, RouterInstanceId } from "@moltzap/router";
import canonicalize from "canonicalize";
import {
  Deferred,
  Effect,
  Encoding,
  Fiber,
  Option,
  Queue,
  Redacted,
  Ref,
  Schema,
} from "effect";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  EndpointEngineInput,
  EngineRegistryPort,
  EngineRouterPort,
} from "../engine-types.js";
import type { RouterWorkerIngress } from "../router-worker/index.js";
import { SendInput } from "../../contract.js";
import { type EndpointEngine, makeEndpointEngine } from "../engine.js";
import {
  type ActionCertifiedRecord as ActionCertifiedRecordValue,
  type ActionCore,
  type ActionProposal,
  type CatchUpIncomplete,
  type CatchUpPage,
  type CatchUpRequest,
  type CertifiedRecord,
  compareAgentIds,
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
  type RecordCore,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  type VerifiedMembership,
  verifyMembershipDescriptor,
} from "../representation.js";
import { type EndpointStore, openEndpointStore } from "../store.js";

/* eslint-disable max-lines, max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- One exact cryptographic trace keeps protocol order and assertions together. */

interface IdentityFixture {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthorityValue;
}

interface RecoveryFixture {
  readonly engine: EndpointEngine;
  readonly input: EndpointEngineInput;
  readonly store: EndpointStore;
  readonly local: IdentityFixture;
  readonly remote: IdentityFixture;
  readonly registryPrivateKey: KeyObject;
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

function forwardStoredOutbound(
  store: EndpointStore,
  outbound: Queue.Queue<SignedMessage>,
  outboundId: string,
): Effect.Effect<void> {
  return store.beginOutbound(outboundId).pipe(
    Effect.flatMap((attempt) => {
      switch (attempt.kind) {
        case "inactive":
          return Effect.void;
        case "pending":
          return decodeCanonical(
            SignedMessage,
            attempt.outbound.canonicalSignedMessage,
          ).pipe(
            Effect.flatMap((message) =>
              store
                .completeOutbound(attempt.outbound)
                .pipe(Effect.zipRight(Queue.offer(outbound, message))),
            ),
            Effect.asVoid,
          );
        default: {
          const exhaustive: never = attempt;
          return exhaustive;
        }
      }
    }),
    Effect.orDie,
  );
}

type ReanchorVote = Extract<
  EvidenceStatementValue,
  { readonly kind: "reanchor_vote" }
>;

const actionSignatureKind: EvidenceStatementValue["kind"] = "action_signature";
const durabilityVoteKind: EvidenceStatementValue["kind"] = "durability_vote";

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const oldRouterInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 8),
);
const newRouterInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 9),
);
const pollCursor = Schema.decodeUnknownSync(PollCursor)(
  `plc_eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwidHlwIjoiYXBwbGljYXRpb24vdm5kLm1vbHR6YXAucG9sbC1jdXJzb3IrandlIn0..${Encoding.encodeBase64Url(new Uint8Array(12).fill(1))}.${Encoding.encodeBase64Url(new Uint8Array(120).fill(2))}.${Encoding.encodeBase64Url(new Uint8Array(16).fill(3))}`,
);

function makeHeldRouter(input: HeldRouterInput) {
  return (context: FixtureRouterContext): EngineRouterPort => ({
    currentAnchor: Effect.succeed({
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

const makeAuthority = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
};

const encodedEvidence = (
  identity: IdentityFixture,
  statement: EvidenceStatementValue,
) =>
  signEvidenceMessage({
    statement,
    agentCard: identity.card,
    signingAuthority: identity.authority,
  }).pipe(Effect.flatMap((message) => Schema.encode(SignedMessage)(message)));

const issueCard = (input: {
  readonly byte: number;
  readonly authority: AgentSigningAuthorityValue;
  readonly registryPrivateKey: KeyObject;
  readonly registrySignerPublicKey: typeof Ed25519PublicKey.Type;
}): Effect.Effect<VerifiedAgentCard> =>
  Effect.gen(function* () {
    const thumbprint = createHash("sha256")
      .update(canonicalize(input.registrySignerPublicKey) ?? "")
      .digest("base64url");
    const protectedText = canonicalize({
      alg: "Ed25519",
      kid: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${thumbprint}`,
      typ: "application/vnd.moltzap.agent-card+jws",
    });
    const payloadText = canonicalize({
      agentId: Schema.decodeUnknownSync(AgentId)(
        identifier("agt_", input.byte),
      ),
      agentName: Schema.decodeUnknownSync(AgentName)(`recovery-${input.byte}`),
      issuedAt: "2026-08-27T12:00:00Z",
      kind: "agentCard",
      moltzapVersion: MOLTZAP_VERSION,
      principalId: Schema.decodeUnknownSync(PrincipalId)(
        identifier("prn_", input.byte),
      ),
      publicKey: AgentSigningAuthority.publicKey(input.authority),
    });
    if (protectedText === undefined || payloadText === undefined) {
      return yield* Effect.dieMessage("canonical card fixture failed");
    }
    const protectedValue = Buffer.from(protectedText).toString("base64url");
    const payload = Buffer.from(payloadText).toString("base64url");
    const signature = signBytes(
      null,
      Buffer.from(`${protectedValue}.${payload}`),
      input.registryPrivateKey,
    ).toString("base64url");
    const card = yield* Schema.decodeUnknown(AgentCard)({
      payload,
      signatures: [{ protected: protectedValue, signature }],
    });
    return yield* AgentCard.verify({
      agentCard: card,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
  }).pipe(Effect.orDie);

const buildCertifiedGenesis = (
  local: IdentityFixture,
  remote: IdentityFixture,
  membership: VerifiedMembership,
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
      routerInstanceId: oldRouterInstanceId,
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
    const localAuthority = yield* makeAuthority();
    const remoteAuthority = yield* makeAuthority();
    const local: IdentityFixture = {
      card: yield* issueCard({
        byte: identityBytes.local,
        authority: localAuthority,
        registryPrivateKey: registryKeys.privateKey,
        registrySignerPublicKey,
      }),
      authority: localAuthority,
    };
    const remote: IdentityFixture = {
      card: yield* issueCard({
        byte: identityBytes.remote,
        authority: remoteAuthority,
        registryPrivateKey: registryKeys.privateKey,
        registrySignerPublicKey,
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
    const registry: EngineRegistryPort = {
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
      registryPrivateKey: registryKeys.privateKey,
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
  send: (outboundId) =>
    forwardStoredOutbound(store, normalOutbound, outboundId),
});

const makeFixture = makeFixtureWithRouter(makeFixtureRouter);
const makeNonLexicalAgentOrderFixture = makeFixtureWithRouter(
  makeFixtureRouter,
  { local: 0, remote: 208 },
);

const addN4Foundation = (fixture: RecoveryFixture) =>
  Effect.gen(function* () {
    const thirdAuthority = yield* makeAuthority();
    const fourthAuthority = yield* makeAuthority();
    const third: IdentityFixture = {
      card: yield* issueCard({
        byte: 3,
        authority: thirdAuthority,
        registryPrivateKey: fixture.registryPrivateKey,
        registrySignerPublicKey: fixture.registrySignerPublicKey,
      }),
      authority: thirdAuthority,
    };
    const fourth: IdentityFixture = {
      card: yield* issueCard({
        byte: 4,
        authority: fourthAuthority,
        registryPrivateKey: fixture.registryPrivateKey,
        registrySignerPublicKey: fixture.registrySignerPublicKey,
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
      routerInstanceId: oldRouterInstanceId,
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
    const registry: EngineRegistryPort = {
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
        expect(restarted).toBeDefined();
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

function peerReanchorVoteIngressFrom(input: {
  readonly membership: VerifiedMembership;
  readonly responder: IdentityFixture;
  readonly proposal: ReanchorVote;
  readonly routerInstanceId: typeof RouterInstanceId.Type;
}): Effect.Effect<RouterWorkerIngress<DecodedOuterBody>> {
  return Effect.gen(function* () {
    const evidence = yield* signEvidenceMessage({
      statement: {
        ...input.proposal,
        signerAgentId: input.responder.card.agentId,
      },
      agentCard: input.responder.card,
      signingAuthority: input.responder.authority,
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
        const recovered = yield* fixture.store.recover();
        expect(recovered.certifiedRecords).toHaveLength(1);
        expect(recovered.outboundMessages).toHaveLength(0);
        expect(recovered.positions[0]?.currentAnchorHash).toBe(
          proposal.anchorHash,
        );
        const resumedActionEvidence = yield* Queue.take(recoveryOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeEvidenceKind),
        );
        const resumedDurabilityEvidence = yield* Queue.take(
          recoveryOutbound,
        ).pipe(Effect.timeout("1 second"), Effect.flatMap(decodeEvidenceKind));
        expect(resumedActionEvidence).toBe(actionSignatureKind);
        expect(resumedDurabilityEvidence).toBe(durabilityVoteKind);

        const sending = yield* Effect.fork(
          fixture.engine.send(
            yield* Schema.decodeUnknown(SendInput)({
              to: `agent:${fixture.remote.card.agentName}`,
              content: [{ type: "text", text: "normal traffic resumes" }],
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
            yield* Schema.decodeUnknown(SendInput)({
              to: `agent:${fixture.remote.card.agentName}`,
              content: [{ type: "text", text: "survive Router restart" }],
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

        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        const resumedOutbound = yield* Queue.unbounded<SignedMessage>();
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

const recoverSameRouterInstance = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const sending = yield* Effect.fork(
          fixture.engine.send(
            yield* Schema.decodeUnknown(SendInput)({
              to: `agent:${fixture.remote.card.agentName}`,
              content: [{ type: "text", text: "retain this proposal" }],
            }),
          ),
        );
        yield* Queue.take(fixture.normalOutbound).pipe(
          Effect.timeout("1 second"),
        );
        const retained = yield* stageCatchUpOutbound(fixture);
        const recoveryOutbound = yield* Queue.unbounded<SignedMessage>();
        const resumedOutbound = yield* Queue.unbounded<SignedMessage>();
        yield* fixture.engine.abandonVolatileFolds("feed_gap");
        const recovering = yield* Effect.fork(
          fixture.engine.recoverCertifiedHistory({
            reason: "feed_gap",
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
        yield* catchUpIncompleteIngress(fixture, request).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));
        const resumed = yield* Queue.take(resumedOutbound).pipe(
          Effect.timeout("1 second"),
        );
        expect(resumed.messageId).toBe(retained.messageId);
        expect(yield* Queue.size(resumedOutbound)).toBe(0);
        expect(yield* Queue.size(fixture.normalOutbound)).toBe(0);
        yield* Fiber.interrupt(sending);
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
        const resumedOutbound = yield* Queue.unbounded<SignedMessage>();
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
        yield* fixture.engine.abandonVolatileFolds("router_restarted");
        const secondRecovery = yield* Effect.fork(
          fixture.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: {
              routerInstanceId: newRouterInstanceId,
              pollCursor,
            },
            resume: () => Effect.void,
            send: ({ message }) =>
              Queue.offer(secondOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const secondRequest = yield* Queue.take(secondOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
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
        const firstOutbound = yield* Queue.unbounded<SignedMessage>();
        const completedSendStarted = yield* Deferred.make<undefined>();
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
                Effect.flatMap((body) =>
                  body.kind === "direct" &&
                  body.packet.kind === "completed_reanchor"
                    ? Deferred.succeed(completedSendStarted, undefined).pipe(
                        Effect.zipRight(Effect.never),
                      )
                    : Queue.offer(firstOutbound, message).pipe(Effect.asVoid),
                ),
              ),
          }),
        );
        const firstRequest = yield* Queue.take(firstOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
        yield* catchUpIncompleteIngress(fixture, firstRequest).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        const proposal = yield* Queue.take(firstOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeReanchorVote),
        );
        yield* peerReanchorVoteIngress(fixture, proposal).pipe(
          Effect.flatMap((ingress) =>
            fixture.engine.acceptRecoveryIngress(ingress),
          ),
        );
        yield* Deferred.await(completedSendStarted).pipe(
          Effect.timeout("1 second"),
        );
        expect(
          (yield* fixture.store.recover()).positions[0]?.currentAnchorHash,
        ).toBe(proposal.anchorHash);
        yield* Fiber.interrupt(firstRecovery);

        const secondOutbound = yield* Queue.unbounded<SignedMessage>();
        yield* fixture.engine.abandonVolatileFolds("router_restarted");
        const secondRecovery = yield* Effect.fork(
          fixture.engine.recoverCertifiedHistory({
            reason: "router_restarted",
            anchor: {
              routerInstanceId: newRouterInstanceId,
              pollCursor,
            },
            resume: () => Effect.void,
            send: ({ message }) =>
              Queue.offer(secondOutbound, message).pipe(Effect.asVoid),
          }),
        );
        const secondRequest = yield* Queue.take(secondOutbound).pipe(
          Effect.timeout("1 second"),
          Effect.flatMap(decodeCatchUpRequest),
        );
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
  it(
    "resumes a same-instance persisted intent without reproposing",
    recoverSameRouterInstance,
  );
  it(
    "rebuilds one discarded record dissemination without duplication",
    recoverDisseminationObligations,
  );
});

/* eslint-enable max-lines, max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- Restore repository defaults. */
