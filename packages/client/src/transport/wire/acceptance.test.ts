/** @file Cryptographic acceptance tests for addressed GENESIS and POST records. */

import {
  AgentCard,
  AgentName,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
  SealedBody,
  SignedMessage,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { RouterInstanceId } from "@moltzap/router";
import { Effect, Either, Option, Schema } from "effect";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  identifier,
  issueTestCard,
  makeTestAuthority,
} from "../../__tests__/agent-card-fixtures.js";
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
  DirectPacket,
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
} from "./index.js";
import { Content, type Content as ContentValue } from "./values.js";

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

const firstRouterInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 41),
);
const secondRouterInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 42),
);

const maximumAgentName = (index: number) =>
  Schema.decodeUnknownSync(AgentName)(
    `member-${String(index).padStart(2, "0")}-${"x".repeat(22)}`,
  );

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
  return Array.from(Array(memberCount).keys(), (index) => index + 1);
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
          const authority = yield* makeTestAuthority();
          const card = yield* issueTestCard({
            byte,
            name: maximumAgentName(byte),
            authority,
            registryKeys,
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
    const recordCore: ActionCertifiedRecord["recordCore"] =
      input.action.kind === "GENESIS"
        ? {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "record_core",
            membership: input.fixture.membership.descriptor,
            anchorHash,
            action: input.action,
            actionHash,
          }
        : {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "record_core",
            membershipHash: input.fixture.membership.hash,
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

/**
 * A POST that succeeds `genesis`, under `reanchored` when the conversation
 * re-anchored after it and under the genesis anchor otherwise.
 */
const buildPost = (
  fixture: ProtocolFixture,
  genesis: RecordFixture,
  content: ContentValue,
  reanchored?: CompletedReanchor,
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
      anchorHash:
        reanchored?.anchorHash ??
        genesis.actionCertifiedRecord.recordCore.anchorHash,
      previousRecordHash: genesis.actionCertifiedRecord.recordHash,
      postIntent,
      postIntentHash: yield* hashPostIntent(postIntent),
    };
    return yield* buildRecord({
      fixture,
      action,
      routerAnchor: reanchored ?? genesis.actionCertifiedRecord.routerAnchor,
    });
  });

/**
 * Every member's vote to re-anchor the conversation at the second Router
 * instance, selecting `selected` as its last certified record.
 */
const voteReanchor = (fixture: ProtocolFixture, selected: RecordFixture) =>
  Effect.gen(function* () {
    const reanchor: ReanchorBody = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "reanchor_body",
      conversationId: fixture.membership.descriptor.conversationId,
      membershipHash: fixture.membership.hash,
      previousAnchorHash: selected.actionCertifiedRecord.recordCore.anchorHash,
      selectedRecordHash: selected.actionCertifiedRecord.recordHash,
      routerInstanceId: secondRouterInstanceId,
    };
    const anchorHash = yield* hashAnchor(reanchor);
    const votes = yield* Effect.forEach(
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
    ).pipe(Effect.flatMap(encodeEvidence));
    return { reanchor, anchorHash, votes };
  });

/**
 * Expect `effect` to fail as a representation error. A value that verifies
 * instead is reported as a short string: reporting the verified value itself,
 * membership keys included, can hang the run.
 * @param effect Verification expected to fail.
 * @returns Completion once the failure is checked.
 */
const expectRepresentationFailure = <Value>(
  effect: Effect.Effect<Value, ClientRepresentationError>,
) =>
  Effect.either(effect).pipe(
    Effect.map(
      Either.match({
        onLeft: (failure): unknown => failure,
        onRight: () => "it verified",
      }),
    ),
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
        membership: fixture.membership,
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
          membership: fixture.membership,
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
      yield* expectRepresentationFailure(
        verifyActionCertifiedRecord({
          record: nonUnanimousGenesis,
          membership: fixture.membership,
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
        membership: fixture.membership,
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
          membership: fixture.membership,
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
          membership: fixture.membership,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        }),
      );
    }),
  );

/**
 * A POST record names its membership only by `MembershipHash`, so it verifies
 * against the membership an endpoint holds from the conversation's GENESIS,
 * and neither without one nor against another conversation's membership. A
 * GENESIS record carries its descriptor and verifies with no held membership,
 * but not against a different held one. Fails when POST verification accepts
 * a hash it cannot resolve to the held membership, or a POST core that names
 * another membership than the one its action and the endpoint hold.
 * @returns Completion after every case is checked.
 */
const resolvesPostMembershipFromTheHeldGenesis = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeProtocolFixture(4);
      const other = yield* makeProtocolFixture(4);
      const genesis = yield* buildGenesis(fixture, [
        { type: "text", text: "genesis" },
      ]);
      const post = yield* buildPost(fixture, genesis, [
        { type: "text", text: "ordinary post" },
      ]);
      const verify = (
        record: CertifiedRecord,
        membership?: VerifiedMembership,
      ) =>
        verifyCertifiedRecord({
          record,
          membership,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        });

      expect((yield* verify(genesis.certifiedRecord)).hash).toBe(
        fixture.membership.hash,
      );
      expect(
        (yield* verify(post.certifiedRecord, fixture.membership)).hash,
      ).toBe(fixture.membership.hash);
      yield* expectRepresentationFailure(verify(post.certifiedRecord));
      yield* expectRepresentationFailure(
        verify(post.certifiedRecord, other.membership),
      );
      yield* expectRepresentationFailure(
        verify(genesis.certifiedRecord, other.membership),
      );

      const postCore = post.actionCertifiedRecord.recordCore;
      if (!("membershipHash" in postCore)) {
        return yield* Effect.dieMessage("a POST core carries a MembershipHash");
      }
      const renamedCore = {
        ...postCore,
        membershipHash: other.membership.hash,
      };
      yield* expectRepresentationFailure(
        verifyActionCertifiedRecord({
          record: {
            ...post.actionCertifiedRecord,
            recordCore: renamedCore,
            recordHash: yield* hashRecord(renamedCore),
          },
          membership: fixture.membership,
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
      const {
        reanchor,
        anchorHash,
        votes: reanchorRepresentations,
      } = yield* voteReanchor(fixture, genesis);
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

/**
 * A member that holds no record catches up GENESIS first: a page for an empty
 * position must carry GENESIS, whose descriptor gives the member the
 * membership a later POST page names only by hash. A POST page then verifies
 * at the position GENESIS sets. Fails when an empty position accepts a POST
 * record, which the member could not resolve without the descriptor.
 * @returns Completion after every page is checked.
 */
const catchesUpGenesisFirst = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeProtocolFixture(4);
      const genesis = yield* buildGenesis(fixture, [
        { type: "text", text: "genesis" },
      ]);
      const post = yield* buildPost(fixture, genesis, [
        { type: "text", text: "after genesis" },
      ]);
      const responder = at(fixture.identities, 0);
      const request = (
        known: Pick<CatchUpRequest, "knownRecordHash" | "knownAnchorHash">,
      ): CatchUpRequest => ({
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_request",
        conversationId: fixture.membership.descriptor.conversationId,
        membershipHash: fixture.membership.hash,
        requesterAgentId: at(fixture.identities, 1).card.agentId,
        ...known,
      });
      const page = (asked: CatchUpRequest, item: CertifiedRecord) =>
        signEvidenceMessage({
          statement: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "catch_up_attestation",
            signerAgentId: responder.card.agentId,
            request: asked,
            itemKind: "certified_record",
            itemHash: item.actionCertifiedRecord.recordHash,
            hasMore: false,
          },
          agentCard: responder.card,
          signingAuthority: responder.authority,
        }).pipe(
          Effect.flatMap((attestation) =>
            Schema.encode(SignedMessage)(attestation),
          ),
          Effect.map(
            (attestation): CatchUpPage => ({
              moltzapVersion: MOLTZAP_VERSION,
              kind: "catch_up_page",
              request: asked,
              item,
              hasMore: false,
              attestation,
            }),
          ),
        );
      const verify = (candidate: CatchUpPage) =>
        verifyCatchUpPage({
          page: candidate,
          membership: fixture.membership,
          responseSenderAgentId: responder.card.agentId,
          registrySignerPublicKey: fixture.registrySignerPublicKey,
        });
      const empty = request({ knownRecordHash: null, knownAnchorHash: null });
      const atGenesis = request({
        knownRecordHash: genesis.actionCertifiedRecord.recordHash,
        knownAnchorHash: genesis.actionCertifiedRecord.recordCore.anchorHash,
      });

      yield* verify(yield* page(empty, genesis.certifiedRecord));
      yield* expectRepresentationFailure(
        verify(yield* page(empty, post.certifiedRecord)),
      );
      yield* verify(yield* page(atGenesis, post.certifiedRecord));
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
      const { reanchor, anchorHash, votes } = yield* voteReanchor(
        fixture,
        genesis,
      );
      const reanchored: CompletedReanchor = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "completed_reanchor",
        anchorHash,
        reanchor,
        certificate: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "reanchor_certificate",
          anchorHash,
          votes: asNonEmpty(votes),
        },
      };
      const post = yield* buildPost(fixture, genesis, content, reanchored);
      const responder = at(fixture.identities, 0);
      const request: CatchUpRequest = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_request",
        conversationId: fixture.membership.descriptor.conversationId,
        membershipHash: fixture.membership.hash,
        requesterAgentId: at(fixture.identities, 1).card.agentId,
        knownRecordHash: genesis.actionCertifiedRecord.recordHash,
        knownAnchorHash: anchorHash,
      };
      const attestation = yield* signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "catch_up_attestation",
          signerAgentId: responder.card.agentId,
          request,
          itemKind: "certified_record",
          itemHash: post.actionCertifiedRecord.recordHash,
          hasMore: false,
        },
        agentCard: responder.card,
        signingAuthority: responder.authority,
      });
      const page: CatchUpPage = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_page",
        request,
        item: post.certifiedRecord,
        hasMore: false,
        attestation: yield* Schema.encode(SignedMessage)(attestation),
      };
      yield* verifyCatchUpPage({
        page,
        membership: fixture.membership,
        responseSenderAgentId: responder.card.agentId,
        registrySignerPublicKey: fixture.registrySignerPublicKey,
      });
      const pagePlaintext = yield* encodeCanonical(DirectPacket, page);
      const outer = yield* signOuterPacket({
        packet: page,
        membership: fixture.membership,
        agentCard: responder.card,
        signingAuthority: responder.authority,
      });
      expect(pagePlaintext.byteLength).toBeLessThanOrEqual(
        Option.getOrThrow(
          SealedBody.maximumPlaintextByteLength(maximumMembers),
        ),
      );
      expect(outer.body.byteLength).toBe(
        Option.getOrThrow(
          SealedBody.sealedByteLength({
            plaintextByteLength: pagePlaintext.byteLength,
            recipientCount: maximumMembers,
          }),
        ),
      );
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

      const evidencePlaintext = yield* encodeCanonical(
        SignedMessage,
        attestation,
      );
      const relayedEvidence = yield* signOuterEvidence({
        evidence: attestation,
        membership: fixture.membership,
        agentCard: responder.card,
        signingAuthority: responder.authority,
      });
      expect(relayedEvidence.body.byteLength).toBe(
        Option.getOrThrow(
          SealedBody.sealedByteLength({
            plaintextByteLength: evidencePlaintext.byteLength,
            recipientCount: maximumMembers,
          }),
        ),
      );
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
    "verifies a POST record only against the membership held from its GENESIS",
    resolvesPostMembershipFromTheHeldGenesis,
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
    "catches up GENESIS first, so a later POST page resolves its membership",
    catchesUpGenesisFirst,
  );
  it(
    "fits the largest catch-up page, a re-anchored POST sealed to its maximum membership, inside Identity limits",
    provesMaximumArtifactFitsIdentity,
  );
});

/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function -- Restore repository defaults. */
