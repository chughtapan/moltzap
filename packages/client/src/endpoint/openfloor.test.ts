/** @file OpenFloorV1 Router-order, grant, expiry, and listener-boundary tests. */

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
import {
  Effect,
  Encoding,
  Redacted,
  Schema,
  TestClock,
  TestContext,
} from "effect";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Content, ConversationId } from "../contract.js";
import { type EngineProspectiveTurn, EngineReplyError } from "./engine.js";
import {
  makeOpenFloor,
  type OpenFloorCertifiedHead,
  openFloorGrantTtlMillis,
  type OpenFloorInput,
  type OpenFloorMulticastCandidate,
  type OpenFloorPort,
} from "./openfloor.js";
import {
  type AckStatement,
  type ActionCertificate,
  type ActionCertifiedRecord,
  type Begin,
  type CertifiedRecord,
  fingerprintReply,
  type GenesisAnchor,
  hashActionCertificate,
  hashActionCertifiedRecord,
  hashAnchor,
  makeActionBinding,
  Membership,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  type StartAction,
  verifyCertifiedRecord,
  verifyMembership,
  verifyStableEvidence,
} from "./representation.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function -- Each cryptographic trace keeps exact protocol order beside its assertions. */

interface IdentityFixture {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthorityValue;
}

interface OpenFloorFixture {
  readonly identities: readonly [
    IdentityFixture,
    IdentityFixture,
    IdentityFixture,
  ];
  readonly head: OpenFloorCertifiedHead;
}

interface CapturedOpenFloorEffects {
  readonly begins: Begin[];
  readonly evidence: SignedMessage[];
  readonly turns: EngineProspectiveTurn[];
  readonly candidates: OpenFloorMulticastCandidate[];
}

type IdentityIndex = 0 | 1 | 2;

const makeCapturedEffects = (): CapturedOpenFloorEffects => ({
  begins: [],
  evidence: [],
  turns: [],
  candidates: [],
});

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const conversationId = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000041",
);

const routerInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 41),
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
      agentName: Schema.decodeUnknownSync(AgentName)(`floor-${input.byte}`),
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
    const parsed = yield* Schema.decodeUnknown(AgentCard)({
      payload,
      signatures: [{ protected: protectedValue, signature }],
    });
    return yield* AgentCard.verify({
      agentCard: parsed,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
  }).pipe(Effect.orDie);

const encodeMessages = (messages: readonly SignedMessage[]) =>
  Effect.forEach(messages, (message) => Schema.encode(SignedMessage)(message), {
    concurrency: 1,
  }).pipe(
    Effect.flatMap((encoded) => {
      const first = encoded[0];
      return first === undefined
        ? Effect.die("missing evidence fixture")
        : Effect.succeed([first, ...encoded.slice(1)] as const);
    }),
  );

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
  ] as const;
  const representations = yield* Effect.forEach(
    cards,
    (card) => Schema.encode(AgentCard)(card),
    { concurrency: 1 },
  );
  const membershipValue = yield* Schema.decodeUnknown(Membership)({
    moltzapVersion: MOLTZAP_VERSION,
    kind: "membership",
    conversationId,
    membershipEpoch: 0,
    members: representations,
  });
  const membership = yield* verifyMembership(
    membershipValue,
    registrySignerPublicKey,
  );
  const anchor: GenesisAnchor = {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "genesis_anchor" as const,
    conversationId,
    membershipHash: membership.hash,
    routerInstanceId,
  };
  const anchorHash = yield* hashAnchor(anchor);
  const action: StartAction = {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "start_action",
    conversationId,
    membershipHash: membership.hash,
    anchorHash,
    previousRecordHash: null,
    beginDigest: null,
    actionId: "START",
    authorAgentId: cards[0].agentId,
    content: [{ type: "text", text: "certified head" }],
    replyFingerprint: null,
  };
  const binding = yield* makeActionBinding(action);
  const actionMessages = yield* Effect.forEach(
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
      }),
    { concurrency: 1 },
  );
  const certificate: ActionCertificate = {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "action_certificate",
    action: binding,
    signatures: yield* encodeMessages(actionMessages),
  };
  const actionRecord: ActionCertifiedRecord = {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "action_certified_record",
    membership: membership.membership,
    anchorHash,
    action,
    actionHash: yield* hashActionCertificate(certificate),
    actionCertificate: certificate,
  };
  const recordHash = yield* hashActionCertifiedRecord(actionRecord);
  const durabilityMessages = yield* Effect.forEach(
    identities,
    ({ card, authority }) =>
      signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "durability_vote",
          signerAgentId: card.agentId,
          conversationId,
          membershipHash: membership.hash,
          recordHash,
        },
        agentCard: card,
        signingAuthority: authority,
      }),
    { concurrency: 1 },
  );
  const record: CertifiedRecord = {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "certified_record",
    recordHash,
    actionCertifiedRecord: actionRecord,
    routerAnchor: anchor,
    durabilityVotes: yield* encodeMessages(durabilityMessages),
  };
  yield* verifyCertifiedRecord({ record, registrySignerPublicKey });
  return {
    identities,
    head: {
      conversationId,
      membership,
      currentAnchorHash: anchorHash,
      recordHash,
      record,
    },
  } satisfies OpenFloorFixture;
});

const makePort = (
  fixture: OpenFloorFixture,
  localIndex: IdentityIndex,
  captured: CapturedOpenFloorEffects,
) => {
  const local = fixture.identities[localIndex];
  const input: OpenFloorInput = {
    localAgentCard: local.card,
    signingAuthority: local.authority,
    store: { hasConsumedAttention: () => Effect.succeed(false) },
    actions: {
      queueBegin: (...parameters) =>
        Effect.sync(() => {
          captured.begins.push(parameters[1]);
        }),
      queueEvidence: (...parameters) =>
        Effect.sync(() => {
          captured.evidence.push(parameters[1]);
        }),
      onMulticastCandidate: (candidate) =>
        Effect.sync(() => {
          captured.candidates.push(candidate);
        }),
      deliverTurn: (turn) =>
        Effect.sync(() => {
          captured.turns.push(turn);
        }),
    },
    randomBytes: () => new Uint8Array(32).fill(17),
  };
  return makeOpenFloor(input);
};

const directIngress = (
  fixture: OpenFloorFixture,
  senderIndex: IdentityIndex,
  packet: Begin,
) =>
  Effect.gen(function* () {
    const sender = fixture.identities[senderIndex];
    const message = yield* signOuterPacket({
      packet,
      membership: fixture.head.membership,
      agentCard: sender.card,
      signingAuthority: sender.authority,
    });
    return {
      message,
      senderCard: sender.card,
      payload: { kind: "direct" as const, packet },
    };
  });

const acknowledgmentIngress = (
  fixture: OpenFloorFixture,
  senderIndex: IdentityIndex,
  statement: AckStatement,
) =>
  Effect.gen(function* () {
    const sender = fixture.identities[senderIndex];
    const evidence = yield* signEvidenceMessage({
      statement,
      agentCard: sender.card,
      signingAuthority: sender.authority,
    });
    const message = yield* signOuterEvidence({
      evidence,
      membership: fixture.head.membership,
      agentCard: sender.card,
      signingAuthority: sender.authority,
    });
    return {
      message,
      senderCard: sender.card,
      payload: { kind: "evidence" as const, message: evidence },
    };
  });

const acknowledgeWinningBegin = (
  fixture: OpenFloorFixture,
  captured: CapturedOpenFloorEffects,
  port: OpenFloorPort,
) =>
  Effect.gen(function* () {
    const localBegin = captured.begins[0];
    if (localBegin === undefined) {
      return yield* Effect.die("missing local BEGIN");
    }
    const localIngress = yield* directIngress(fixture, 1, localBegin);
    expect(yield* port.acceptIngress(localIngress)).toBe("accepted");
    expect(captured.evidence).toHaveLength(1);
    const laterBegin: Begin = {
      ...localBegin,
      contenderAgentId: fixture.identities[2].card.agentId,
    };
    expect(
      yield* port.acceptIngress(yield* directIngress(fixture, 2, laterBegin)),
    ).toBe("ignored");
    const localEvidence = captured.evidence[0];
    if (localEvidence === undefined) {
      return yield* Effect.die("missing local ACK");
    }
    const decoded = yield* verifyStableEvidence({
      representation: yield* Schema.encode(SignedMessage)(localEvidence),
      membership: fixture.head.membership,
    });
    if (decoded.statement.kind !== "ack") {
      return yield* Effect.die("unexpected evidence kind");
    }
    for (const senderIndex of [0, 1, 2] as const) {
      const statement: AckStatement = {
        ...decoded.statement,
        signerAgentId: fixture.identities[senderIndex].card.agentId,
      };
      yield* port.acceptIngress(
        yield* acknowledgmentIngress(fixture, senderIndex, statement),
      );
    }
    return decoded.statement;
  });

const assertOneUseGrant = (
  fixture: OpenFloorFixture,
  captured: CapturedOpenFloorEffects,
  port: OpenFloorPort,
  acknowledgment: AckStatement,
) =>
  Effect.gen(function* () {
    expect(captured.turns).toHaveLength(1);
    const turn = captured.turns[0];
    if (turn === undefined) {
      return yield* Effect.die("missing granted turn");
    }
    const reply: Content = [{ type: "text", text: "bound reply" }];
    const candidate = yield* port.admitReply(turn.replyGrant, reply);
    expect(candidate.beginDigest).toBe(acknowledgment.beginDigest);
    expect(candidate.action.previousRecordHash).toBe(fixture.head.recordHash);
    expect(candidate.action.anchorHash).toBe(fixture.head.currentAnchorHash);
    expect(candidate.action.replyFingerprint).toBe(
      yield* fingerprintReply(reply),
    );
    const duplicate = yield* Effect.flip(
      port.admitReply(turn.replyGrant, reply),
    );
    expect(duplicate).toBeInstanceOf(EngineReplyError);
    expect(duplicate.reason).toBe("authority-unavailable");
  });

const pinsRouterOrderAndOneUseGrant = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const captured = makeCapturedEffects();
        const port = yield* makePort(fixture, 1, captured);
        yield* port.certifiedHead(fixture.head);
        expect(captured.begins).toHaveLength(0);
        yield* port.listenerAttached;
        expect(captured.begins).toHaveLength(1);
        const acknowledgment = yield* acknowledgeWinningBegin(
          fixture,
          captured,
          port,
        );
        yield* assertOneUseGrant(fixture, captured, port, acknowledgment);
      }),
    ),
  );

const expiresWithoutRecordAndRecontends = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const captured = makeCapturedEffects();
        const port = yield* makePort(fixture, 1, captured);
        yield* port.certifiedHead(fixture.head);
        yield* port.listenerAttached;
        const begin = captured.begins[0];
        if (begin === undefined) {
          return yield* Effect.die("missing initial BEGIN");
        }
        yield* port.acceptIngress(yield* directIngress(fixture, 1, begin));
        yield* TestClock.adjust(openFloorGrantTtlMillis);
        yield* Effect.yieldNow();
        expect(captured.begins).toHaveLength(2);
        expect(captured.turns).toHaveLength(0);
        expect(captured.candidates).toHaveLength(0);
        yield* port.listenerDetached;
        yield* TestClock.adjust(openFloorGrantTtlMillis);
        expect(captured.begins).toHaveLength(2);
      }).pipe(Effect.provide(TestContext.TestContext)),
    ),
  );

const suppressesSelfAuthoredHeads = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const captured = makeCapturedEffects();
        const port = yield* makePort(fixture, 0, captured);
        yield* port.certifiedHead(fixture.head);
        yield* port.listenerAttached;
        expect(captured.begins).toHaveLength(0);
      }),
    ),
  );

// @agent-code-guard/regression-only: these traces pin the sole automatic OpenFloor attention path and its volatile authority.
describe("OpenFloorV1", () => {
  it(
    "uses Router callback order and admits a bound grant exactly once",
    pinsRouterOrderAndOneUseGrant,
  );
  it(
    "expires without a record and recontends only while subscribed",
    expiresWithoutRecordAndRecontends,
  );
  it(
    "never automatically contends on a self-authored head",
    suppressesSelfAuthoredHeads,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function -- Restore repository defaults. */
