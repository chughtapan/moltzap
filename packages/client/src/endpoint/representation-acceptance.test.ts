/** @file Cryptographic acceptance tests for addressed GENESIS and POST records. */

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
import { RouterInstanceId } from "@moltzap/router";
import canonicalize from "canonicalize";
import { Effect, Encoding, Redacted, Schema } from "effect";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { Content, type Content as ContentValue } from "../contract.js";
import {
  type ActionCertifiedRecord,
  type ActionCore,
  type ActionHash,
  type ActionProposal,
  type CatchUpPage,
  type CatchUpRequest,
  type CertifiedRecord,
  ClientRepresentationError,
  type CompletedReanchor,
  deriveConversationId,
  encodeCanonical,
  type GenesisAnchorBody,
  hashAction,
  hashAnchor,
  hashPostIntent,
  hashRecord,
  maximumContentBytes,
  maximumMembers,
  MembershipDescriptor as MembershipDescriptorSchema,
  mintPostId,
  type PostIntent,
  quorumThreshold,
  type ReanchorBody,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  type VerifiedMembership,
  verifyActionCertifiedRecord,
  verifyActionProposal,
  verifyCatchUpPage,
  verifyCertifiedRecord,
  verifyCompletedReanchor,
  verifyMembershipDescriptor,
} from "./representation.js";

/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function -- Acceptance fixtures keep each complete cryptographic record and its assertions together. */

const maximumIdentityBodyBytes = 262_144;
const maximumIdentityRecipients = 128;

interface IdentityFixture {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthorityValue;
}

interface ProtocolFixture {
  readonly identities: readonly IdentityFixture[];
  readonly membership: VerifiedMembership;
  readonly registrySignerPublicKey: typeof Ed25519PublicKey.Type;
}

interface RecordFixture {
  readonly action: ActionCore;
  readonly actionHash: ActionHash;
  readonly actionRepresentations: readonly unknown[];
  readonly actionCertifiedRecord: ActionCertifiedRecord;
  readonly durabilityRepresentations: readonly unknown[];
  readonly certifiedRecord: CertifiedRecord;
}

const identifier = (prefix: string, byteLength: number, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(byteLength).fill(byte))}`;

const firstRouterInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 16, 41),
);
const secondRouterInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 16, 42),
);

const makeAuthority = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
};

const maximumAgentName = (index: number) =>
  Schema.decodeUnknownSync(AgentName)(
    `member-${String(index).padStart(2, "0")}-${"x".repeat(22)}`,
  );

const issueCard = (input: {
  readonly byte: number;
  readonly authority: AgentSigningAuthorityValue;
  readonly registryPrivateKey: KeyObject;
  readonly registrySignerPublicKey: typeof Ed25519PublicKey.Type;
}) =>
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
        identifier("agt_", 16, input.byte),
      ),
      agentName: maximumAgentName(input.byte),
      issuedAt: `2026-08-13T12:00:${String(input.byte).padStart(2, "0")}Z`,
      kind: "agentCard",
      moltzapVersion: MOLTZAP_VERSION,
      principalId: Schema.decodeUnknownSync(PrincipalId)(
        identifier("prn_", 16, input.byte),
      ),
      publicKey: AgentSigningAuthority.publicKey(input.authority),
    });
    if (protectedText === undefined || payloadText === undefined) {
      return yield* Effect.die("canonical AgentCard fixture failed");
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

function asNonEmpty<Value>(
  values: readonly Value[],
): readonly [Value, ...Value[]] {
  const first = values[0];
  if (first === undefined) {
    throw new Error("expected a nonempty fixture list");
  }
  return [first, ...values.slice(1)];
}

function asAtLeastTwo<Value>(
  values: readonly Value[],
): readonly [Value, Value, ...Value[]] {
  const first = values[0];
  const second = values[1];
  if (first === undefined || second === undefined) {
    throw new Error("expected at least two fixture items");
  }
  return [first, second, ...values.slice(2)];
}

function at<Value>(values: readonly Value[], index: number): Value {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`missing fixture item ${index}`);
  }
  return value;
}

function identityBytes(memberCount: number): readonly number[] {
  const bytes: number[] = [];
  for (let byte = 1; byte <= memberCount; byte += 1) {
    bytes.push(byte);
  }
  return bytes;
}

const makeProtocolFixture = (memberCount: number) =>
  Effect.gen(function* () {
    const registryKeys = generateKeyPairSync("ed25519");
    const registrySignerPublicKey = yield* Schema.decodeUnknown(
      Ed25519PublicKey,
    )(registryKeys.publicKey.export({ format: "jwk" }));
    const identities = yield* Effect.forEach(
      identityBytes(memberCount),
      (byte) =>
        Effect.gen(function* () {
          const authority = yield* makeAuthority();
          const card = yield* issueCard({
            byte,
            authority,
            registryPrivateKey: registryKeys.privateKey,
            registrySignerPublicKey,
          });
          return { card, authority } satisfies IdentityFixture;
        }),
      { concurrency: 1 },
    );
    const encodedCards = yield* Effect.forEach(
      identities,
      ({ card }) => Schema.encode(AgentCard)(card),
      { concurrency: 1 },
    );
    const memberAgentIds = asAtLeastTwo(
      identities.map(({ card }) => card.agentId),
    );
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptorSchema)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "membership_descriptor",
      conversationId: yield* deriveConversationId(memberAgentIds),
      members: asAtLeastTwo(encodedCards),
    });
    return {
      identities,
      membership: yield* verifyMembershipDescriptor(
        descriptor,
        registrySignerPublicKey,
      ),
      registrySignerPublicKey,
    } satisfies ProtocolFixture;
  });

const encodeEvidence = (messages: readonly SignedMessage[]) =>
  Effect.forEach(messages, (message) => Schema.encode(SignedMessage)(message), {
    concurrency: 1,
  });

const signActionEvidence = (fixture: ProtocolFixture, actionHash: ActionHash) =>
  Effect.forEach(
    fixture.identities,
    ({ card, authority }) =>
      signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "action_signature",
          signerAgentId: card.agentId,
          actionHash,
        },
        agentCard: card,
        signingAuthority: authority,
      }),
    { concurrency: 1 },
  );

const signDurabilityEvidence = (
  fixture: ProtocolFixture,
  recordHash: ActionCertifiedRecord["recordHash"],
) =>
  Effect.forEach(
    fixture.identities,
    ({ card, authority }) =>
      signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "durability_vote",
          signerAgentId: card.agentId,
          conversationId: fixture.membership.descriptor.conversationId,
          membershipHash: fixture.membership.hash,
          recordHash,
        },
        agentCard: card,
        signingAuthority: authority,
      }),
    { concurrency: 1 },
  );

const buildRecord = (input: {
  readonly fixture: ProtocolFixture;
  readonly action: ActionCore;
  readonly routerAnchor: ActionCertifiedRecord["routerAnchor"];
}) =>
  Effect.gen(function* () {
    const actionHash = yield* hashAction(input.action);
    const actionMessages = yield* signActionEvidence(input.fixture, actionHash);
    const actionRepresentations = yield* encodeEvidence(actionMessages);
    const anchorHash =
      input.action.kind === "GENESIS"
        ? yield* hashAnchor(input.action.anchor)
        : input.action.anchorHash;
    const recordCore: ActionCertifiedRecord["recordCore"] = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "record_core",
      membership: input.fixture.membership.descriptor,
      anchorHash,
      action: input.action,
      actionHash,
    };
    const recordHash = yield* hashRecord(recordCore);
    const actionCertifiedRecord: ActionCertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certified_record",
      recordHash,
      recordCore,
      routerAnchor: input.routerAnchor,
      actionCertificate: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_certificate",
        actionHash,
        signatures: asNonEmpty(actionRepresentations),
      },
    };
    const durabilityMessages = yield* signDurabilityEvidence(
      input.fixture,
      recordHash,
    );
    const durabilityRepresentations = yield* encodeEvidence(durabilityMessages);
    const certifiedRecord: CertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "certified_record",
      actionCertifiedRecord,
      durabilityCertificate: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "durability_certificate",
        recordHash,
        votes: asNonEmpty(durabilityRepresentations),
      },
    };
    return {
      action: input.action,
      actionHash,
      actionRepresentations,
      actionCertifiedRecord,
      durabilityRepresentations,
      certifiedRecord,
    } satisfies RecordFixture;
  });

const buildGenesis = (fixture: ProtocolFixture, content: ContentValue) =>
  Effect.gen(function* () {
    const firstIdentity = at(fixture.identities, 0);
    const postIntent: PostIntent = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "post_intent",
      conversationId: fixture.membership.descriptor.conversationId,
      membershipHash: fixture.membership.hash,
      authorAgentId: firstIdentity.card.agentId,
      postId: yield* mintPostId(),
      content,
    };
    const anchor: GenesisAnchorBody = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "genesis_anchor_body",
      conversationId: fixture.membership.descriptor.conversationId,
      membershipHash: fixture.membership.hash,
      routerInstanceId: firstRouterInstanceId,
    };
    const action: ActionCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "GENESIS",
      conversationId: fixture.membership.descriptor.conversationId,
      membership: fixture.membership.descriptor,
      anchor,
      previousRecordHash: null,
      postIntent,
      postIntentHash: yield* hashPostIntent(postIntent),
    };
    return yield* buildRecord({ fixture, action, routerAnchor: anchor });
  });

const buildPost = (
  fixture: ProtocolFixture,
  genesis: RecordFixture,
  content: ContentValue,
) =>
  Effect.gen(function* () {
    const firstIdentity = at(fixture.identities, 0);
    const postIntent: PostIntent = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "post_intent",
      conversationId: fixture.membership.descriptor.conversationId,
      membershipHash: fixture.membership.hash,
      authorAgentId: firstIdentity.card.agentId,
      postId: yield* mintPostId(),
      content,
    };
    const action: ActionCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "POST",
      conversationId: fixture.membership.descriptor.conversationId,
      membershipHash: fixture.membership.hash,
      anchorHash: genesis.actionCertifiedRecord.recordCore.anchorHash,
      previousRecordHash: genesis.actionCertifiedRecord.recordHash,
      postIntent,
      postIntentHash: yield* hashPostIntent(postIntent),
    };
    return yield* buildRecord({
      fixture,
      action,
      routerAnchor: genesis.actionCertifiedRecord.routerAnchor,
    });
  });

const expectRepresentationFailure = <Value>(
  effect: Effect.Effect<Value, ClientRepresentationError>,
) =>
  Effect.flip(effect).pipe(
    Effect.tap((failure) => {
      expect(failure).toBeInstanceOf(ClientRepresentationError);
      return Effect.void;
    }),
    Effect.asVoid,
  );

const verifiesThreshold = (memberCount: number, expectedThreshold: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeProtocolFixture(memberCount);
      const genesis = yield* buildGenesis(fixture, [
        { type: "text", text: `members-${memberCount}` },
      ]);
      const accepted: CertifiedRecord = {
        ...genesis.certifiedRecord,
        durabilityCertificate: {
          ...genesis.certifiedRecord.durabilityCertificate,
          votes: asNonEmpty(
            genesis.durabilityRepresentations.slice(0, expectedThreshold),
          ),
        },
      };
      expect(quorumThreshold(memberCount)).toBe(expectedThreshold);
      yield* verifyCertifiedRecord({
        record: accepted,
        registrySignerPublicKey: fixture.registrySignerPublicKey,
      });
      const belowThreshold: CertifiedRecord = {
        ...accepted,
        durabilityCertificate: {
          ...accepted.durabilityCertificate,
          votes: asNonEmpty(
            genesis.durabilityRepresentations.slice(0, expectedThreshold - 1),
          ),
        },
      };
      yield* expectRepresentationFailure(
        verifyCertifiedRecord({
          record: belowThreshold,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );
    }),
  );

const enforcesGenesisAndPostEvidence = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeProtocolFixture(4);
      const genesis = yield* buildGenesis(fixture, [
        { type: "text", text: "genesis" },
      ]);
      const nonUnanimousGenesis: ActionCertifiedRecord = {
        ...genesis.actionCertifiedRecord,
        actionCertificate: {
          ...genesis.actionCertifiedRecord.actionCertificate,
          signatures: asNonEmpty(genesis.actionRepresentations.slice(0, 3)),
        },
      };
      expect(nonUnanimousGenesis.recordHash).toBe(
        genesis.actionCertifiedRecord.recordHash,
      );
      expect(nonUnanimousGenesis.recordCore.actionHash).toBe(
        genesis.actionHash,
      );
      yield* expectRepresentationFailure(
        verifyActionCertifiedRecord({
          record: nonUnanimousGenesis,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );

      const post = yield* buildPost(fixture, genesis, [
        { type: "text", text: "ordinary post" },
      ]);
      const thresholdPost: ActionCertifiedRecord = {
        ...post.actionCertifiedRecord,
        actionCertificate: {
          ...post.actionCertifiedRecord.actionCertificate,
          signatures: asNonEmpty(post.actionRepresentations.slice(0, 3)),
        },
      };
      yield* verifyActionCertifiedRecord({
        record: thresholdPost,
        registrySignerPublicKey: fixture.registrySignerPublicKey,
      });
      const missingAuthor: ActionCertifiedRecord = {
        ...thresholdPost,
        actionCertificate: {
          ...thresholdPost.actionCertificate,
          signatures: [
            at(post.actionRepresentations, 1),
            at(post.actionRepresentations, 2),
            at(post.actionRepresentations, 3),
          ],
        },
      };
      yield* expectRepresentationFailure(
        verifyActionCertifiedRecord({
          record: missingAuthor,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );

      const wrongEvidenceKind: CertifiedRecord = {
        ...post.certifiedRecord,
        durabilityCertificate: {
          ...post.certifiedRecord.durabilityCertificate,
          votes: [
            at(post.actionRepresentations, 0),
            at(post.durabilityRepresentations, 1),
            at(post.durabilityRepresentations, 2),
          ],
        },
      };
      yield* expectRepresentationFailure(
        verifyCertifiedRecord({
          record: wrongEvidenceKind,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );
    }),
  );

const verifiesProposalEnvelopeAttribution = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeProtocolFixture(4);
      const genesis = yield* buildGenesis(fixture, [
        { type: "text", text: "proposal" },
      ]);
      const author = at(fixture.identities, 0).card.agentId;
      const proposal: ActionProposal = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_proposal",
        action: genesis.action,
      };
      yield* verifyActionProposal({
        proposal,
        membership: fixture.membership,
        outerSenderAgentId: author,
      });
      yield* expectRepresentationFailure(
        verifyActionProposal({
          proposal,
          membership: fixture.membership,
          outerSenderAgentId: at(fixture.identities, 1).card.agentId,
        }),
      );
    }),
  );

const verifiesReanchorCatchUpBindings = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeProtocolFixture(4);
      const genesis = yield* buildGenesis(fixture, [
        { type: "text", text: "catch up" },
      ]);
      const reanchor: ReanchorBody = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "reanchor_body",
        conversationId: fixture.membership.descriptor.conversationId,
        membershipHash: fixture.membership.hash,
        previousAnchorHash: genesis.actionCertifiedRecord.recordCore.anchorHash,
        selectedRecordHash: genesis.actionCertifiedRecord.recordHash,
        routerInstanceId: secondRouterInstanceId,
      };
      const anchorHash = yield* hashAnchor(reanchor);
      const reanchorMessages = yield* Effect.forEach(
        fixture.identities,
        ({ card, authority }) =>
          signEvidenceMessage({
            statement: {
              moltzapVersion: MOLTZAP_VERSION,
              kind: "reanchor_vote",
              signerAgentId: card.agentId,
              anchorHash,
              reanchor,
            },
            agentCard: card,
            signingAuthority: authority,
          }),
        { concurrency: 1 },
      );
      const reanchorRepresentations = yield* encodeEvidence(reanchorMessages);
      const completed: CompletedReanchor = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "completed_reanchor",
        anchorHash,
        reanchor,
        certificate: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "reanchor_certificate",
          anchorHash,
          votes: asNonEmpty(reanchorRepresentations.slice(0, 3)),
        },
      };
      yield* verifyCompletedReanchor({
        completed,
        membership: fixture.membership,
      });

      const responder = at(fixture.identities, 0);
      const request: CatchUpRequest = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_request",
        conversationId: fixture.membership.descriptor.conversationId,
        membershipHash: fixture.membership.hash,
        requesterAgentId: at(fixture.identities, 1).card.agentId,
        knownRecordHash: genesis.actionCertifiedRecord.recordHash,
        knownAnchorHash: genesis.actionCertifiedRecord.recordCore.anchorHash,
      };
      const attestation = yield* signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "catch_up_attestation",
          signerAgentId: responder.card.agentId,
          request,
          itemKind: "completed_reanchor",
          itemHash: completed.anchorHash,
          hasMore: false,
        },
        agentCard: responder.card,
        signingAuthority: responder.authority,
      });
      const page: CatchUpPage = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_page",
        request,
        item: completed,
        hasMore: false,
        attestation: yield* Schema.encode(SignedMessage)(attestation),
      };
      yield* verifyCatchUpPage({
        page,
        membership: fixture.membership,
        responseSenderAgentId: responder.card.agentId,
        registrySignerPublicKey: fixture.registrySignerPublicKey,
      });
      yield* expectRepresentationFailure(
        verifyCatchUpPage({
          page,
          membership: fixture.membership,
          responseSenderAgentId: at(fixture.identities, 1).card.agentId,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );
    }),
  );

const provesMaximumArtifactFitsIdentity = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeProtocolFixture(maximumMembers);
      const empty = [{ type: "text", text: "" }] as const;
      const fixedBytes = yield* encodeCanonical(Content, empty);
      const content = yield* Schema.decodeUnknown(Content)([
        {
          type: "text",
          text: "x".repeat(maximumContentBytes - fixedBytes.byteLength),
        },
      ]);
      const genesis = yield* buildGenesis(fixture, content);
      const responder = at(fixture.identities, 0);
      const request: CatchUpRequest = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_request",
        conversationId: fixture.membership.descriptor.conversationId,
        membershipHash: fixture.membership.hash,
        requesterAgentId: at(fixture.identities, 1).card.agentId,
        knownRecordHash: null,
        knownAnchorHash: null,
      };
      const attestation = yield* signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "catch_up_attestation",
          signerAgentId: responder.card.agentId,
          request,
          itemKind: "certified_record",
          itemHash: genesis.actionCertifiedRecord.recordHash,
          hasMore: false,
        },
        agentCard: responder.card,
        signingAuthority: responder.authority,
      });
      const page: CatchUpPage = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_page",
        request,
        item: genesis.certifiedRecord,
        hasMore: false,
        attestation: yield* Schema.encode(SignedMessage)(attestation),
      };
      const outer = yield* signOuterPacket({
        packet: page,
        membership: fixture.membership,
        agentCard: responder.card,
        signingAuthority: responder.authority,
      });
      expect(outer.body.byteLength).toBeLessThanOrEqual(
        maximumIdentityBodyBytes,
      );
      expect(outer.recipientAgentIds).toHaveLength(maximumMembers);
      expect(outer.recipientAgentIds.length).toBeLessThanOrEqual(
        maximumIdentityRecipients,
      );
      expect(SignedMessage.encodedByteLength(outer)).toBeLessThanOrEqual(
        SignedMessage.maximumEncodedByteLength,
      );

      const relayedEvidence = yield* signOuterEvidence({
        evidence: attestation,
        membership: fixture.membership,
        agentCard: responder.card,
        signingAuthority: responder.authority,
      });
      expect(relayedEvidence.body.byteLength).toBeLessThanOrEqual(
        maximumIdentityBodyBytes,
      );
    }),
  );

// @agent-code-guard/regression-only: these cases pin the accepted quorum, evidence, recovery, and size boundaries.
describe("Client protocol acceptance", () => {
  it.each([
    [2, 2],
    [3, 3],
    [4, 3],
    [10, 7],
  ] as const)(
    "accepts q(%i)=%i durability evidence and rejects one fewer vote",
    verifiesThreshold,
  );
  it(
    "requires unanimous GENESIS and author-inclusive POST evidence without hashing either certificate",
    enforcesGenesisAndPostEvidence,
  );
  it(
    "requires the proposal envelope sender to be the post author",
    verifiesProposalEnvelopeAttribution,
  );
  it(
    "binds re-anchor and catch-up evidence to the exact position and responder",
    verifiesReanchorCatchUpBindings,
  );
  it(
    "fits the maximum complete catch-up artifact inside Identity limits",
    provesMaximumArtifactFitsIdentity,
  );
});

/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function -- Restore repository defaults. */
