/** @file Fixed-member catch-up ordering and Router-reanchor threshold tests. */

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
  Queue,
  Redacted,
  Schema,
  SubscriptionRef,
} from "effect";
import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationId } from "../contract.js";
import { engineRecoveryState } from "./engine-catch-up.js";
import {
  acceptEngineRecoveryIngress,
  recoverCertifiedHistory,
} from "./engine-reanchor.js";
import type { EngineRuntime } from "./engine-types.js";
import {
  type ActionCertificate,
  type ActionCertifiedRecord,
  type CatchUpIncomplete,
  type CatchUpPage,
  type CatchUpRequest,
  type CertifiedRecord,
  decodeCanonical,
  decodeOuterBody,
  encodeCanonical,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  GenesisAnchor,
  hashActionCertificate,
  hashActionCertifiedRecord,
  hashAnchor,
  makeActionBinding,
  Membership,
  type MembershipHash,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  type StartAction,
  verifyMembership,
} from "./representation.js";
import { openEndpointStore } from "./store.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function -- Exact cryptographic traces keep their protocol ordering assertions local. */

interface IdentityFixture {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthorityValue;
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const conversationId = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000001",
);
const oldInstance = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 8),
);
const newInstance = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 9),
);
const pollCursor = Schema.decodeUnknownSync(PollCursor)(
  `plc_eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwidHlwIjoiYXBwbGljYXRpb24vdm5kLm1vbHR6YXAucG9sbC1jdXJzb3IrandlIn0..${Encoding.encodeBase64Url(new Uint8Array(12).fill(1))}.${Encoding.encodeBase64Url(new Uint8Array(120).fill(2))}.${Encoding.encodeBase64Url(new Uint8Array(16).fill(3))}`,
);

const makeAuthority = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
};

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
      agentName: Schema.decodeUnknownSync(AgentName)(`recovery-${input.byte}`),
      issuedAt: `2026-08-13T12:00:0${input.byte}Z`,
      kind: "agentCard",
      moltzapVersion: MOLTZAP_VERSION,
      principalId: Schema.decodeUnknownSync(PrincipalId)(
        identifier("prn_", input.byte),
      ),
      publicKey: AgentSigningAuthority.publicKey(input.authority),
    });
    if (protectedText === undefined || payloadText === undefined) {
      return yield* Effect.die("canonical fixture failed");
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
  identities: readonly [IdentityFixture, IdentityFixture, IdentityFixture],
  membership: typeof Membership.Type,
  membershipHash: MembershipHash,
) =>
  Effect.gen(function* () {
    const genesisAnchor: typeof GenesisAnchor.Type = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "genesis_anchor" as const,
      conversationId,
      membershipHash,
      routerInstanceId: oldInstance,
    };
    const anchorHash = yield* hashAnchor(genesisAnchor);
    const action: StartAction = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "start_action" as const,
      conversationId,
      membershipHash,
      anchorHash,
      previousRecordHash: null,
      beginDigest: null,
      actionId: "START" as const,
      authorAgentId: identities[0].card.agentId,
      content: [{ type: "text" as const, text: "caught up" }],
      replyFingerprint: null,
    };
    const binding = yield* makeActionBinding(action);
    const actionSignatures = yield* Effect.forEach(
      identities,
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
        }).pipe(
          Effect.flatMap((message) => Schema.encode(SignedMessage)(message)),
        ),
      { concurrency: 1 },
    );
    const certificate: ActionCertificate = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certificate" as const,
      action: binding,
      signatures: [
        actionSignatures[0],
        actionSignatures[1],
        actionSignatures[2],
      ],
    };
    const actionCertifiedRecord: ActionCertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certified_record" as const,
      membership,
      anchorHash,
      action,
      actionHash: yield* hashActionCertificate(certificate),
      actionCertificate: certificate,
    };
    const recordHash = yield* hashActionCertifiedRecord(actionCertifiedRecord);
    const votes = yield* Effect.forEach(
      identities,
      ({ card, authority }) =>
        signEvidenceMessage({
          statement: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "durability_vote",
            signerAgentId: card.agentId,
            conversationId,
            membershipHash,
            recordHash,
          },
          agentCard: card,
          signingAuthority: authority,
        }).pipe(
          Effect.flatMap((message) => Schema.encode(SignedMessage)(message)),
        ),
      { concurrency: 1 },
    );
    const certified: CertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "certified_record",
      recordHash,
      actionCertifiedRecord,
      routerAnchor: genesisAnchor,
      durabilityVotes: [votes[0], votes[1], votes[2]],
    };
    return { genesisAnchor, anchorHash, certified };
  });

const makeFixture = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const authorities = [
    yield* makeAuthority(),
    yield* makeAuthority(),
    yield* makeAuthority(),
  ] as const;
  const cards = [
    yield* issueCard({
      byte: 1,
      authority: authorities[0],
      registryPrivateKey: registryKeys.privateKey,
      registrySignerPublicKey,
    }),
    yield* issueCard({
      byte: 2,
      authority: authorities[1],
      registryPrivateKey: registryKeys.privateKey,
      registrySignerPublicKey,
    }),
    yield* issueCard({
      byte: 3,
      authority: authorities[2],
      registryPrivateKey: registryKeys.privateKey,
      registrySignerPublicKey,
    }),
  ] as const;
  const identities = [
    { card: cards[0], authority: authorities[0] },
    { card: cards[1], authority: authorities[1] },
    { card: cards[2], authority: authorities[2] },
  ] as const satisfies readonly [
    IdentityFixture,
    IdentityFixture,
    IdentityFixture,
  ];
  const membership = yield* Schema.decodeUnknown(Membership)({
    moltzapVersion: MOLTZAP_VERSION,
    kind: "membership",
    conversationId,
    membershipEpoch: 0,
    members: [
      yield* Schema.encode(AgentCard)(cards[0]),
      yield* Schema.encode(AgentCard)(cards[1]),
      yield* Schema.encode(AgentCard)(cards[2]),
    ],
  });
  const verifiedMembership = yield* verifyMembership(
    membership,
    registrySignerPublicKey,
  );
  const record = yield* buildCertifiedGenesis(
    identities,
    membership,
    verifiedMembership.hash,
  );
  const store = yield* openEndpointStore(
    mkdtempSync(join(tmpdir(), "moltzap-recovery-")),
  );
  yield* store.bindStartIntent({
    conversationId,
    canonicalIntent: new TextEncoder().encode("recovery-intent"),
  });
  yield* store.putConversationFoundation({
    conversationId,
    membershipHash: verifiedMembership.hash,
    canonicalMembership: yield* encodeCanonical(Membership, membership),
    anchorHash: record.anchorHash,
    canonicalAnchor: yield* encodeCanonical(
      GenesisAnchor,
      record.genesisAnchor,
    ),
  });
  const runtime: EngineRuntime = {
    input: {
      localAgentCard: cards[0],
      signingAuthority: authorities[0],
      registrySignerPublicKey,
      registry: { lookup: () => Effect.die("unused registry") },
      store,
      routerWorker: {
        currentAnchor: Effect.die("recovery must not read active anchor"),
        send: () => Effect.die("recovery must use carried send"),
      },
    },
    conversations: new Map(),
    multicastFolds: new Map(),
    recordFolds: new Map(),
    completions: new Map(),
    outbound: [],
    outboundSignal: yield* Queue.unbounded<void>(),
    gate: yield* Effect.makeSemaphore(1),
    outboundGate: yield* Effect.makeSemaphore(1),
    listenerGate: yield* Effect.makeSemaphore(1),
    revision: yield* SubscriptionRef.make(0),
  };
  return {
    runtime,
    store,
    identities,
    membership: verifiedMembership,
    certified: record.certified,
  };
});

const decodeRequest = (message: typeof SignedMessage.Type) =>
  decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) =>
      body.kind === "direct" && body.packet.kind === "catch_up_request"
        ? Effect.succeed(body.packet)
        : Effect.die("expected catch-up request"),
    ),
  );

const incompleteIngress = (
  fixture: Effect.Effect.Success<typeof makeFixture>,
  peer: 1 | 2,
  request: CatchUpRequest,
) =>
  Effect.gen(function* () {
    const identity = fixture.identities[peer];
    const evidence = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_attestation",
        signerAgentId: identity.card.agentId,
        request,
        itemKind: "incomplete",
        itemHash: null,
        hasMore: false,
      },
      agentCard: identity.card,
      signingAuthority: identity.authority,
    });
    const packet: CatchUpIncomplete = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_incomplete" as const,
      request,
      attestation: yield* Schema.encode(SignedMessage)(evidence),
    };
    const message = yield* signOuterPacket({
      packet,
      membership: fixture.membership,
      agentCard: identity.card,
      signingAuthority: identity.authority,
    });
    return {
      message,
      senderCard: identity.card,
      payload: { kind: "direct" as const, packet },
    };
  });

const pageIngress = (
  fixture: Effect.Effect.Success<typeof makeFixture>,
  request: CatchUpRequest,
) =>
  Effect.gen(function* () {
    const identity = fixture.identities[2];
    const evidence = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "catch_up_attestation",
        signerAgentId: identity.card.agentId,
        request,
        itemKind: "certified_record",
        itemHash: fixture.certified.recordHash,
        hasMore: false,
      },
      agentCard: identity.card,
      signingAuthority: identity.authority,
    });
    const packet: CatchUpPage = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_page" as const,
      request,
      item: fixture.certified,
      hasMore: false,
      attestation: yield* Schema.encode(SignedMessage)(evidence),
    };
    const message = yield* signOuterPacket({
      packet,
      membership: fixture.membership,
      agentCard: identity.card,
      signingAuthority: identity.authority,
    });
    return {
      message,
      senderCard: identity.card,
      payload: { kind: "direct" as const, packet },
    };
  });

type ReanchorVote = Extract<
  EvidenceStatementValue,
  { readonly kind: "reanchor_vote" }
>;

const decodeReanchorVote = (message: typeof SignedMessage.Type) =>
  decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) =>
      body.kind === "evidence"
        ? decodeCanonical(EvidenceStatement, body.message.body)
        : Effect.die("expected re-anchor evidence"),
    ),
    Effect.flatMap((statement) =>
      statement.kind === "reanchor_vote"
        ? Effect.succeed(statement)
        : Effect.die("expected re-anchor vote"),
    ),
  );

const reanchorVoteIngress = (
  fixture: Effect.Effect.Success<typeof makeFixture>,
  peer: 1 | 2,
  proposal: ReanchorVote,
) =>
  Effect.gen(function* () {
    const identity = fixture.identities[peer];
    const evidence = yield* signEvidenceMessage({
      statement: {
        ...proposal,
        signerAgentId: identity.card.agentId,
      },
      agentCard: identity.card,
      signingAuthority: identity.authority,
    });
    const message = yield* signOuterEvidence({
      evidence,
      membership: fixture.membership,
      agentCard: identity.card,
      signingAuthority: identity.authority,
    });
    return {
      message,
      senderCard: identity.card,
      payload: { kind: "evidence" as const, message: evidence },
    };
  });

const acceptsDescendantAfterStaleIncomplete = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const outbound = yield* Queue.unbounded<typeof SignedMessage.Type>();
        const recovering = yield* Effect.fork(
          recoverCertifiedHistory(fixture.runtime, {
            reason: "feed_gap",
            anchor: { routerInstanceId: newInstance, pollCursor },
            send: (message) =>
              Queue.offer(outbound, message).pipe(Effect.asVoid),
          }),
        );
        const firstRequest = yield* Queue.take(outbound).pipe(
          Effect.flatMap(decodeRequest),
        );
        yield* incompleteIngress(fixture, 1, firstRequest).pipe(
          Effect.flatMap((ingress) =>
            acceptEngineRecoveryIngress(fixture.runtime, ingress),
          ),
        );
        const page = yield* pageIngress(fixture, firstRequest);
        expect(yield* acceptEngineRecoveryIngress(fixture.runtime, page)).toBe(
          "accepted",
        );
        expect(yield* acceptEngineRecoveryIngress(fixture.runtime, page)).toBe(
          "ignored",
        );
        const nextRequest = yield* Queue.take(outbound).pipe(
          Effect.flatMap(decodeRequest),
        );
        expect(nextRequest.knownRecordHash).toBe(fixture.certified.recordHash);
        for (const peer of [1, 2] as const) {
          yield* incompleteIngress(fixture, peer, nextRequest).pipe(
            Effect.flatMap((ingress) =>
              acceptEngineRecoveryIngress(fixture.runtime, ingress),
            ),
          );
        }
        yield* Fiber.join(recovering).pipe(Effect.timeout("1 second"));
        const recovered = yield* fixture.store.recover();
        expect(recovered.certifiedRecords).toHaveLength(1);
        expect(
          fixture.runtime.conversations.get(conversationId)?.head?.recordHash,
        ).toBe(fixture.certified.recordHash);
      }),
    ),
  );

const completesOnlyAfterDistinctThresholdVotes = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const outbound = yield* Queue.unbounded<typeof SignedMessage.Type>();
        const recovering = yield* Effect.fork(
          recoverCertifiedHistory(fixture.runtime, {
            reason: "router_restarted",
            anchor: { routerInstanceId: newInstance, pollCursor },
            send: (message) =>
              Queue.offer(outbound, message).pipe(Effect.asVoid),
          }),
        );
        const firstRequest = yield* Queue.take(outbound).pipe(
          Effect.timeout("1010 millis"),
          Effect.flatMap(decodeRequest),
        );
        yield* pageIngress(fixture, firstRequest).pipe(
          Effect.flatMap((ingress) =>
            acceptEngineRecoveryIngress(fixture.runtime, ingress),
          ),
        );
        const nextRequest = yield* Queue.take(outbound).pipe(
          Effect.timeout("1020 millis"),
          Effect.flatMap(decodeRequest),
        );
        for (const peer of [1, 2] as const) {
          yield* incompleteIngress(fixture, peer, nextRequest).pipe(
            Effect.flatMap((ingress) =>
              acceptEngineRecoveryIngress(fixture.runtime, ingress),
            ),
          );
        }
        const proposal = yield* Queue.take(outbound).pipe(
          Effect.timeout("1030 millis"),
          Effect.flatMap(decodeReanchorVote),
        );
        expect(proposal.reanchor).toMatchObject({
          conversationId,
          previousAnchorHash:
            fixture.certified.actionCertifiedRecord.anchorHash,
          selectedRecordHash: fixture.certified.recordHash,
          routerInstanceId: newInstance,
        });
        const peerVote = yield* reanchorVoteIngress(fixture, 1, proposal);
        expect(
          yield* acceptEngineRecoveryIngress(fixture.runtime, peerVote),
        ).toBe("accepted");
        expect(
          yield* acceptEngineRecoveryIngress(fixture.runtime, peerVote),
        ).toBe("accepted");
        const belowThreshold = yield* fixture.store.recover();
        expect(
          belowThreshold.evidence.filter(({ kind }) => kind === "reanchor"),
        ).toHaveLength(2);
        expect(
          belowThreshold.stagedReanchors[0]?.canonicalCompletedReanchor,
        ).toBeUndefined();
        yield* reanchorVoteIngress(fixture, 2, proposal).pipe(
          Effect.flatMap((ingress) =>
            acceptEngineRecoveryIngress(fixture.runtime, ingress),
          ),
        );
        const completedMessage = yield* Queue.take(outbound).pipe(
          Effect.timeout("1040 millis"),
        );
        const completedBody = yield* decodeOuterBody(completedMessage.body);
        expect(completedBody).toMatchObject({
          kind: "direct",
          packet: {
            kind: "completed_reanchor",
            anchorHash: proposal.anchorHash,
          },
        });
        yield* Effect.yieldNow();
        const activeRecovery = engineRecoveryState(fixture.runtime);
        if (activeRecovery !== undefined) {
          expect(activeRecovery.pendingOutbound).toBe(0);
          expect(
            activeRecovery.completedConversations.has(conversationId),
          ).toBe(true);
          expect((yield* Deferred.poll(activeRecovery.completion))._tag).toBe(
            "Some",
          );
        }
        yield* Fiber.join(recovering).pipe(Effect.timeout("1050 millis"));
        const recovered = yield* fixture.store.recover();
        expect(recovered.positions[0]?.currentAnchorHash).toBe(
          proposal.anchorHash,
        );
        expect(
          recovered.evidence.filter(({ kind }) => kind === "reanchor"),
        ).toHaveLength(3);
        expect(
          recovered.stagedReanchors[0]?.canonicalCompletedReanchor,
        ).toBeDefined();
      }),
    ),
  );

describe("endpoint recovery", () => {
  it(
    "accepts one descendant and ignores a repeated catch-up page",
    acceptsDescendantAfterStaleIncomplete,
  );
  it(
    "completes a Router restart only after distinct threshold votes",
    completesOnlyAfterDistinctThresholdVotes,
  );
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function -- Restore repository defaults. */
