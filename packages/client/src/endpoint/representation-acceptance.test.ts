/** @file Quorum, evidence-separation, and maximum-derived-size acceptance tests. */

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
import { type Content, ConversationId } from "../contract.js";
import {
  type ActionCertificate,
  type ActionCertifiedRecord,
  type Begin,
  BeginDigest,
  type CatchUpIncomplete,
  type CatchUpPage,
  type CatchUpRequest,
  type CertifiedRecord,
  ClientRepresentationError,
  type CompletedReanchor,
  Content as ContentSchema,
  type DirectPacket,
  durabilityThreshold,
  encodeCanonical,
  fingerprintReply,
  hashActionCertificate,
  hashActionCertifiedRecord,
  hashAnchor,
  makeActionBinding,
  maximumContentBytes,
  maximumMembers,
  Membership,
  type MulticastAction,
  type MulticastProposal,
  type ReanchorBody,
  RecordHash,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  type StartAction,
  type StartProposal,
  type VerifiedMembership,
  verifyActionCertifiedRecord,
  verifyCertifiedRecord,
  verifyMembership,
} from "./representation.js";

/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function -- These acceptance traces keep exact cryptographic fixtures and their boundary assertions together. */

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

interface CertifiedFixture {
  readonly actionCertifiedRecord: ActionCertifiedRecord;
  readonly actionRepresentations: readonly unknown[];
  readonly certifiedRecord: CertifiedRecord;
  readonly durabilityRepresentations: readonly unknown[];
  readonly genesisAnchor: StartProposal["genesisAnchor"];
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const conversationId = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000001",
);
const firstRouterInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 41),
);
const secondRouterInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 42),
);
const beginDigest = Schema.decodeUnknownSync(BeginDigest)(
  `bgn_${Encoding.encodeBase64Url(new Uint8Array(32).fill(43))}`,
);

const makeAuthority = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
};

const maximumAgentName = (index: number) =>
  Schema.decodeUnknownSync(AgentName)(
    `m-${String(index).padStart(2, "0")}-${"x".repeat(27)}`,
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
        identifier("agt_", input.byte),
      ),
      agentName: maximumAgentName(input.byte),
      issuedAt: `2026-08-13T12:00:${String(input.byte).padStart(2, "0")}Z`,
      kind: "agentCard",
      moltzapVersion: MOLTZAP_VERSION,
      principalId: Schema.decodeUnknownSync(PrincipalId)(
        identifier("prn_", input.byte),
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

const asNonEmpty = <Value>(
  values: readonly Value[],
): readonly [Value, ...Value[]] => {
  const first = values[0];
  if (first === undefined) {
    throw new Error("expected a nonempty fixture list");
  }
  return [first, ...values.slice(1)];
};

const at = <Value>(values: readonly Value[], index: number): Value => {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`missing fixture item ${index}`);
  }
  return value;
};

const identityBytes = (memberCount: number): readonly number[] => {
  const bytes: number[] = [];
  for (let byte = 1; byte <= memberCount; byte += 1) {
    bytes.push(byte);
  }
  return bytes;
};

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
    const membership = yield* Schema.decodeUnknown(Membership)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "membership",
      conversationId,
      membershipEpoch: 0,
      members: encodedCards,
    });
    return {
      identities,
      membership: yield* verifyMembership(membership, registrySignerPublicKey),
      registrySignerPublicKey,
    } satisfies ProtocolFixture;
  });

const signActionEvidence = (
  fixture: ProtocolFixture,
  action: ActionCertifiedRecord["action"],
) =>
  Effect.gen(function* () {
    const binding = yield* makeActionBinding(action);
    return yield* Effect.forEach(
      fixture.identities,
      ({ card, authority }) =>
        signEvidenceMessage({
          statement: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "action_signature",
            signerAgentId: card.agentId,
            action: binding,
          },
          agentCard: card,
          signingAuthority: authority,
        }),
      { concurrency: 1 },
    );
  });

const buildCertifiedFixture = (fixture: ProtocolFixture, content: Content) =>
  Effect.gen(function* () {
    const genesisAnchor: StartProposal["genesisAnchor"] = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "genesis_anchor",
      conversationId,
      membershipHash: fixture.membership.hash,
      routerInstanceId: firstRouterInstanceId,
    };
    const anchorHash = yield* hashAnchor(genesisAnchor);
    const action: StartAction = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "start_action",
      conversationId,
      membershipHash: fixture.membership.hash,
      anchorHash,
      previousRecordHash: null,
      beginDigest: null,
      actionId: "START",
      authorAgentId: at(fixture.identities, 0).card.agentId,
      content,
      replyFingerprint: null,
    };
    const actionMessages = yield* signActionEvidence(fixture, action);
    const actionRepresentations = yield* Effect.forEach(
      actionMessages,
      (message) => Schema.encode(SignedMessage)(message),
      { concurrency: 1 },
    );
    const actionCertificate: ActionCertificate = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certificate",
      action: yield* makeActionBinding(action),
      signatures: asNonEmpty(actionRepresentations),
    };
    const actionCertifiedRecord: ActionCertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certified_record",
      membership: fixture.membership.membership,
      anchorHash,
      action,
      actionHash: yield* hashActionCertificate(actionCertificate),
      actionCertificate,
    };
    const recordHash = yield* hashActionCertifiedRecord(actionCertifiedRecord);
    const durabilityMessages = yield* Effect.forEach(
      fixture.identities,
      ({ card, authority }) =>
        signEvidenceMessage({
          statement: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "durability_vote",
            signerAgentId: card.agentId,
            conversationId,
            membershipHash: fixture.membership.hash,
            recordHash,
          },
          agentCard: card,
          signingAuthority: authority,
        }),
      { concurrency: 1 },
    );
    const durabilityRepresentations = yield* Effect.forEach(
      durabilityMessages,
      (message) => Schema.encode(SignedMessage)(message),
      { concurrency: 1 },
    );
    const certifiedRecord: CertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "certified_record",
      recordHash,
      actionCertifiedRecord,
      routerAnchor: genesisAnchor,
      durabilityVotes: asNonEmpty(durabilityRepresentations),
    };
    return {
      actionCertifiedRecord,
      actionRepresentations,
      certifiedRecord,
      durabilityRepresentations,
      genesisAnchor,
    } satisfies CertifiedFixture;
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

const provesThresholdBoundaries = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cases = [
        { members: 2, threshold: 2, honestReplicas: 2 },
        { members: 3, threshold: 3, honestReplicas: 3 },
        { members: 4, threshold: 3, honestReplicas: 2 },
        { members: 7, threshold: 5, honestReplicas: 3 },
      ] as const;
      for (const expected of cases) {
        const fixture = yield* makeProtocolFixture(expected.members);
        const certified = yield* buildCertifiedFixture(fixture, [
          { type: "text", text: `quorum-${expected.members}` },
        ]);
        const threshold = durabilityThreshold(expected.members);
        const faultBound = Math.floor((expected.members - 1) / 3);
        expect(threshold).toBe(expected.threshold);
        expect(expected.members - 2 * faultBound).toBe(expected.honestReplicas);
        const accepted: CertifiedRecord = {
          ...certified.certifiedRecord,
          durabilityVotes: asNonEmpty(
            certified.durabilityRepresentations.slice(0, threshold),
          ),
        };
        yield* verifyCertifiedRecord({
          record: accepted,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        });
        const belowThreshold: CertifiedRecord = {
          ...certified.certifiedRecord,
          durabilityVotes: asNonEmpty(
            certified.durabilityRepresentations.slice(0, threshold - 1),
          ),
        };
        yield* expectRepresentationFailure(
          verifyCertifiedRecord({
            record: belowThreshold,
            registrySignerPublicKey: fixture.registrySignerPublicKey,
          }),
        );
      }
      for (
        let memberCount = 2;
        memberCount <= maximumMembers;
        memberCount += 1
      ) {
        const faultBound = Math.floor((memberCount - 1) / 3);
        expect(durabilityThreshold(memberCount)).toBe(
          memberCount < 4 ? memberCount : memberCount - faultBound,
        );
      }
    }),
  );

const rejectsWrongDuplicateAndConflictingEvidence = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeProtocolFixture(4);
      const certified = yield* buildCertifiedFixture(fixture, [
        { type: "text", text: "separate evidence domains" },
      ]);
      const thresholdActionCertificate: ActionCertificate = {
        ...certified.actionCertifiedRecord.actionCertificate,
        signatures: asNonEmpty(certified.actionRepresentations.slice(0, 3)),
      };
      yield* expectRepresentationFailure(
        verifyActionCertifiedRecord({
          record: {
            ...certified.actionCertifiedRecord,
            actionHash: yield* hashActionCertificate(
              thresholdActionCertificate,
            ),
            actionCertificate: thresholdActionCertificate,
          },
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );

      const wrongActionCertificate: ActionCertificate = {
        ...certified.actionCertifiedRecord.actionCertificate,
        signatures: [
          at(certified.actionRepresentations, 0),
          at(certified.actionRepresentations, 1),
          at(certified.durabilityRepresentations, 2),
          at(certified.actionRepresentations, 3),
        ],
      };
      yield* expectRepresentationFailure(
        verifyActionCertifiedRecord({
          record: {
            ...certified.actionCertifiedRecord,
            actionHash: yield* hashActionCertificate(wrongActionCertificate),
            actionCertificate: wrongActionCertificate,
          },
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );

      const wrongDurabilityKind: CertifiedRecord = {
        ...certified.certifiedRecord,
        durabilityVotes: [
          at(certified.actionRepresentations, 0),
          at(certified.durabilityRepresentations, 1),
          at(certified.durabilityRepresentations, 2),
        ],
      };
      yield* expectRepresentationFailure(
        verifyCertifiedRecord({
          record: wrongDurabilityKind,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );

      const duplicateVote: CertifiedRecord = {
        ...certified.certifiedRecord,
        durabilityVotes: [
          at(certified.durabilityRepresentations, 0),
          at(certified.durabilityRepresentations, 0),
          at(certified.durabilityRepresentations, 2),
        ],
      };
      yield* expectRepresentationFailure(
        verifyCertifiedRecord({
          record: duplicateVote,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );

      const conflictingRecordHash = Schema.decodeUnknownSync(RecordHash)(
        `rch_${Encoding.encodeBase64Url(new Uint8Array(32).fill(99))}`,
      );
      const conflictingIdentity = at(fixture.identities, 2);
      const conflictingVote = yield* signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "durability_vote",
          signerAgentId: conflictingIdentity.card.agentId,
          conversationId,
          membershipHash: fixture.membership.hash,
          recordHash: conflictingRecordHash,
        },
        agentCard: conflictingIdentity.card,
        signingAuthority: conflictingIdentity.authority,
      }).pipe(
        Effect.flatMap((message) => Schema.encode(SignedMessage)(message)),
      );
      const conflictingVotes: CertifiedRecord = {
        ...certified.certifiedRecord,
        durabilityVotes: [
          at(certified.durabilityRepresentations, 0),
          at(certified.durabilityRepresentations, 1),
          conflictingVote,
        ],
      };
      yield* expectRepresentationFailure(
        verifyCertifiedRecord({
          record: conflictingVotes,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );
    }),
  );

const makeMaximumContent = () =>
  Effect.gen(function* () {
    const empty = [{ type: "text", text: "" }] as const;
    const fixedBytes = yield* encodeCanonical(ContentSchema, empty);
    const content: Content = [
      {
        type: "text" as const,
        text: "x".repeat(maximumContentBytes - fixedBytes.byteLength),
      },
    ];
    expect(yield* encodeCanonical(ContentSchema, content)).toHaveLength(
      maximumContentBytes,
    );
    return content;
  });

const startActionOf = (record: ActionCertifiedRecord): StartAction => {
  if (record.action.kind !== "start_action") {
    throw new Error("expected the START fixture action");
  }
  return record.action;
};

const buildCompletedReanchor = (
  fixture: ProtocolFixture,
  certified: CertifiedFixture,
) =>
  Effect.gen(function* () {
    const reanchorBody: ReanchorBody = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "reanchor_body",
      conversationId,
      membershipHash: fixture.membership.hash,
      previousAnchorHash: certified.actionCertifiedRecord.anchorHash,
      selectedRecordHash: certified.certifiedRecord.recordHash,
      routerInstanceId: secondRouterInstanceId,
    };
    const reanchorHash = yield* hashAnchor(reanchorBody);
    const reanchorMessages = yield* Effect.forEach(
      fixture.identities,
      ({ card, authority }) =>
        signEvidenceMessage({
          statement: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "reanchor_vote",
            signerAgentId: card.agentId,
            anchorHash: reanchorHash,
            reanchor: reanchorBody,
          },
          agentCard: card,
          signingAuthority: authority,
        }),
      { concurrency: 1 },
    );
    const reanchorRepresentations = yield* Effect.forEach(
      reanchorMessages,
      (message) => Schema.encode(SignedMessage)(message),
      { concurrency: 1 },
    );
    const completedReanchor: CompletedReanchor = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "completed_reanchor",
      anchorHash: reanchorHash,
      reanchor: reanchorBody,
      votes: asNonEmpty(reanchorRepresentations),
    };
    return { completedReanchor, reanchorMessages };
  });

const buildMulticastCertifiedFixture = (
  fixture: ProtocolFixture,
  content: Content,
  certified: CertifiedFixture,
  completedReanchor: CompletedReanchor,
) =>
  Effect.gen(function* () {
    const firstIdentity = at(fixture.identities, 0);
    const multicastAction: MulticastAction = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "multicast_action",
      conversationId,
      membershipHash: fixture.membership.hash,
      anchorHash: completedReanchor.anchorHash,
      previousRecordHash: certified.certifiedRecord.recordHash,
      beginDigest,
      actionId: "MULTICAST",
      authorAgentId: firstIdentity.card.agentId,
      content,
      replyFingerprint: yield* fingerprintReply(content),
    };
    const multicastActionMessages = yield* signActionEvidence(
      fixture,
      multicastAction,
    );
    const multicastActionRepresentations = yield* Effect.forEach(
      multicastActionMessages,
      (message) => Schema.encode(SignedMessage)(message),
      { concurrency: 1 },
    );
    const multicastActionCertificate: ActionCertificate = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certificate",
      action: yield* makeActionBinding(multicastAction),
      signatures: asNonEmpty(multicastActionRepresentations),
    };
    const multicastActionCertifiedRecord: ActionCertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certified_record",
      membership: fixture.membership.membership,
      anchorHash: completedReanchor.anchorHash,
      action: multicastAction,
      actionHash: yield* hashActionCertificate(multicastActionCertificate),
      actionCertificate: multicastActionCertificate,
    };
    const multicastRecordHash = yield* hashActionCertifiedRecord(
      multicastActionCertifiedRecord,
    );
    const multicastDurabilityMessages = yield* Effect.forEach(
      fixture.identities,
      ({ card, authority }) =>
        signEvidenceMessage({
          statement: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "durability_vote",
            signerAgentId: card.agentId,
            conversationId,
            membershipHash: fixture.membership.hash,
            recordHash: multicastRecordHash,
          },
          agentCard: card,
          signingAuthority: authority,
        }),
      { concurrency: 1 },
    );
    const multicastDurabilityRepresentations = yield* Effect.forEach(
      multicastDurabilityMessages,
      (message) => Schema.encode(SignedMessage)(message),
      { concurrency: 1 },
    );
    const multicastCertifiedRecord: CertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "certified_record",
      recordHash: multicastRecordHash,
      actionCertifiedRecord: multicastActionCertifiedRecord,
      routerAnchor: completedReanchor,
      durabilityVotes: asNonEmpty(multicastDurabilityRepresentations),
    };
    return {
      multicastAction,
      multicastActionMessages,
      multicastActionCertifiedRecord,
      multicastCertifiedRecord,
    };
  });

const buildCatchUpFixture = (
  fixture: ProtocolFixture,
  multicastCertifiedRecord: CertifiedRecord,
  completedReanchor: CompletedReanchor,
) =>
  Effect.gen(function* () {
    const firstIdentity = at(fixture.identities, 0);
    const request: CatchUpRequest = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_request",
      conversationId,
      membershipHash: fixture.membership.hash,
      requesterAgentId: firstIdentity.card.agentId,
      knownRecordHash: multicastCertifiedRecord.recordHash,
      knownAnchorHash: completedReanchor.anchorHash,
    };
    const catchUpAttestation = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_attestation",
        signerAgentId: firstIdentity.card.agentId,
        request,
        itemKind: "certified_record",
        itemHash: multicastCertifiedRecord.recordHash,
        hasMore: false,
      },
      agentCard: firstIdentity.card,
      signingAuthority: firstIdentity.authority,
    });
    const encodedCatchUpAttestation =
      yield* Schema.encode(SignedMessage)(catchUpAttestation);
    const incompleteAttestation = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_attestation",
        signerAgentId: firstIdentity.card.agentId,
        request,
        itemKind: "incomplete",
        itemHash: null,
        hasMore: false,
      },
      agentCard: firstIdentity.card,
      signingAuthority: firstIdentity.authority,
    });
    const catchUpPage: CatchUpPage = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_page",
      request,
      item: multicastCertifiedRecord,
      hasMore: false,
      attestation: encodedCatchUpAttestation,
    };
    const catchUpIncomplete: CatchUpIncomplete = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_incomplete",
      request,
      attestation: yield* Schema.encode(SignedMessage)(incompleteAttestation),
    };
    return {
      request,
      catchUpAttestation,
      catchUpPage,
      catchUpIncomplete,
    };
  });

const provesEveryMaximumArtifactFitsIdentity = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeProtocolFixture(maximumMembers);
      const content = yield* makeMaximumContent();
      const certified = yield* buildCertifiedFixture(fixture, content);
      const firstIdentity = at(fixture.identities, 0);
      const { completedReanchor, reanchorMessages } =
        yield* buildCompletedReanchor(fixture, certified);
      const {
        multicastAction,
        multicastActionMessages,
        multicastActionCertifiedRecord,
        multicastCertifiedRecord,
      } = yield* buildMulticastCertifiedFixture(
        fixture,
        content,
        certified,
        completedReanchor,
      );
      const { request, catchUpAttestation, catchUpPage, catchUpIncomplete } =
        yield* buildCatchUpFixture(
          fixture,
          multicastCertifiedRecord,
          completedReanchor,
        );
      const multicastProposal: MulticastProposal = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "multicast_proposal",
        action: multicastAction,
      };
      const begin: Begin = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "begin",
        conversationId,
        membershipHash: fixture.membership.hash,
        anchorHash: certified.actionCertifiedRecord.anchorHash,
        previousRecordHash: certified.certifiedRecord.recordHash,
        actionId: "MULTICAST",
        contenderAgentId: firstIdentity.card.agentId,
      };
      const startProposal: StartProposal = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "start_proposal",
        membership: fixture.membership.membership,
        genesisAnchor: certified.genesisAnchor,
        action: startActionOf(certified.actionCertifiedRecord),
      };
      const packets: readonly DirectPacket[] = [
        startProposal,
        begin,
        multicastProposal,
        multicastActionCertifiedRecord,
        multicastCertifiedRecord,
        request,
        catchUpPage,
        catchUpIncomplete,
        completedReanchor,
      ];
      for (const packet of packets) {
        const message = yield* signOuterPacket({
          packet,
          membership: fixture.membership,
          agentCard: firstIdentity.card,
          signingAuthority: firstIdentity.authority,
        });
        expect(message.body.byteLength).toBeLessThanOrEqual(
          maximumIdentityBodyBytes,
        );
        expect(message.recipientAgentIds).toHaveLength(maximumMembers);
        expect(message.recipientAgentIds.length).toBeLessThanOrEqual(
          maximumIdentityRecipients,
        );
        expect(SignedMessage.encodedByteLength(message)).toBeLessThanOrEqual(
          SignedMessage.maximumEncodedByteLength,
        );
      }

      const ackEvidence = yield* signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "ack",
          signerAgentId: firstIdentity.card.agentId,
          conversationId,
          membershipHash: fixture.membership.hash,
          previousRecordHash: certified.certifiedRecord.recordHash,
          beginDigest,
        },
        agentCard: firstIdentity.card,
        signingAuthority: firstIdentity.authority,
      });
      const evidence = [
        at(multicastActionMessages, 0),
        yield* signEvidenceMessage({
          statement: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "durability_vote",
            signerAgentId: firstIdentity.card.agentId,
            conversationId,
            membershipHash: fixture.membership.hash,
            recordHash: certified.certifiedRecord.recordHash,
          },
          agentCard: firstIdentity.card,
          signingAuthority: firstIdentity.authority,
        }),
        ackEvidence,
        catchUpAttestation,
        at(reanchorMessages, 0),
      ];
      for (const inner of evidence) {
        const message = yield* signOuterEvidence({
          evidence: inner,
          membership: fixture.membership,
          agentCard: firstIdentity.card,
          signingAuthority: firstIdentity.authority,
        });
        expect(message.body.byteLength).toBeLessThanOrEqual(
          maximumIdentityBodyBytes,
        );
        expect(message.recipientAgentIds).toHaveLength(maximumMembers);
        expect(SignedMessage.encodedByteLength(message)).toBeLessThanOrEqual(
          SignedMessage.maximumEncodedByteLength,
        );
      }
    }),
  );

// @agent-code-guard/regression-only: these cases pin the accepted private Client quorum and representation limits at their cryptographic boundary.
describe("Client protocol acceptance bounds", () => {
  it(
    "enforces durability thresholds and honest-replica bounds",
    provesThresholdBoundaries,
  );
  it(
    "separates action and durability evidence and rejects duplicate or conflicting votes",
    rejectsWrongDuplicateAndConflictingEvidence,
  );
  it(
    "fits every maximum complete Client artifact inside Identity limits",
    provesEveryMaximumArtifactFitsIdentity,
  );
});

/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function -- Restore repository defaults. */
