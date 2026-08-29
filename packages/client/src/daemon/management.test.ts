/** @file Canonical addressed management projection and closed failures. */

import {
  AgentCard,
  AgentId,
  AgentName,
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
  PrincipalId,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import {
  Registry,
  type RegistryLookupResult,
} from "@moltzap/identity/registry";
import canonicalize from "canonicalize";
import {
  type Context,
  Effect,
  Encoding,
  Layer,
  Redacted,
  Schema,
} from "effect";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DaemonBootstrap } from "./configuration.js";
import {
  compareAgentIds,
  deriveConversationId,
  encodeCanonical,
  hashMembershipDescriptor,
  MembershipDescriptor,
} from "../endpoint/representation.js";
import {
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
} from "../endpoint/store.js";
import {
  managementReadConversationRequestSchema,
  managementSearchConversationsRequestSchema,
  managementSearchConversationsResultSchema,
} from "../management-runtime.js";
import { makeDaemonManagementOperations } from "./management.js";

interface IdentityFixture {
  readonly bootstrap: DaemonBootstrap;
  readonly cards: readonly [VerifiedAgentCard, VerifiedAgentCard];
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const hash = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`;

const makeAuthority = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
};

const issueCard = (input: {
  readonly byte: number;
  readonly name: string;
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
      agentName: Schema.decodeUnknownSync(AgentName)(input.name),
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

const makeIdentityFixture = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const localAuthority = yield* makeAuthority();
  const remoteAuthority = yield* makeAuthority();
  const local = yield* issueCard({
    byte: 1,
    name: "alice",
    authority: localAuthority,
    registryPrivateKey: registryKeys.privateKey,
    registrySignerPublicKey,
  });
  const remote = yield* issueCard({
    byte: 2,
    name: "bob",
    authority: remoteAuthority,
    registryPrivateKey: registryKeys.privateKey,
    registrySignerPublicKey,
  });
  const bootstrap: DaemonBootstrap = Object.freeze({
    configuration: {
      stateDirectory: "/var/lib/moltzapd",
      mcpPort: 4319,
      registryOrigin: new URL("https://registry.example"),
      registrySignerPublicKey,
      routerOrigin: new URL("https://router.example"),
      agentPrivateKeyFile: Redacted.make("/run/secrets/agent.pem"),
      admissionCredentialFile: Redacted.make("/run/secrets/admission"),
    },
    signingAuthority: localAuthority,
    agentPublicKey: AgentSigningAuthority.publicKey(localAuthority),
    admissionCredential: Redacted.make("bootstrap-token="),
  });
  return { bootstrap, cards: [local, remote] } satisfies IdentityFixture;
}).pipe(Effect.orDie);

const makeDirectMembership = (fixture: IdentityFixture) =>
  Effect.gen(function* () {
    const cards = fixture.cards.slice();
    cards.sort((left, right) => compareAgentIds(left.agentId, right.agentId));
    const firstAgent = cards[0];
    const secondAgent = cards[1];
    if (firstAgent === undefined || secondAgent === undefined) {
      return yield* Effect.dieMessage("direct fixture lost a member");
    }
    const firstCard = yield* Schema.encode(AgentCard)(firstAgent);
    const secondCard = yield* Schema.encode(AgentCard)(secondAgent);
    const conversationId = yield* deriveConversationId([
      firstAgent.agentId,
      secondAgent.agentId,
    ]);
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "membership_descriptor",
      conversationId,
      members: [firstCard, secondCard],
    });
    const membershipHash = yield* hashMembershipDescriptor(descriptor);
    return {
      conversationId,
      membershipHash,
      canonicalMembership: yield* encodeCanonical(
        MembershipDescriptor,
        descriptor,
      ),
    };
  }).pipe(Effect.orDie);

const makeRecovery = (fixture: IdentityFixture) =>
  Effect.gen(function* () {
    const membership = yield* makeDirectMembership(fixture);
    const canonicalAgentCard = yield* encodeCanonical(
      AgentCard,
      fixture.cards[0],
    );
    const recovery: EndpointRecovery = {
      identity: {
        agentId: fixture.cards[0].agentId,
        canonicalAgentCard,
      },
      postIntents: [],
      memberships: [
        {
          conversationId: membership.conversationId,
          membershipHash: membership.membershipHash,
          canonicalMembership: membership.canonicalMembership,
        },
      ],
      anchors: [],
      positions: [
        {
          conversationId: membership.conversationId,
          membershipHash: membership.membershipHash,
          currentAnchorHash: hash("anc_", 3),
          headRecordHash: hash("rch_", 4),
        },
      ],
      proposalLocks: [],
      stagedRecords: [],
      evidence: [],
      certifiedRecords: [],
      stagedReanchors: [],
      pendingDeliveries: [],
      disseminationObligations: [],
      outboundMessages: [],
    };
    return recovery;
  }).pipe(Effect.orDie);

function outsideManagementTest<Value>(): Effect.Effect<Value> {
  return Effect.dieMessage("outside management test");
}

function makeStore(input: {
  readonly recovery: EndpointRecovery;
  readonly historyFailure?: EndpointStoreError;
}): EndpointStore {
  return {
    readIdentity: () => Effect.succeed(input.recovery.identity),
    bindIdentity: () => outsideManagementTest(),
    bindPostIntent: () => outsideManagementTest(),
    putConversationFoundation: () => outsideManagementTest(),
    lockProposal: () => outsideManagementTest(),
    lockGenesisProposal: () => outsideManagementTest(),
    stageRecord: () => outsideManagementTest(),
    stageRecordForDissemination: () => outsideManagementTest(),
    mergeEvidence: () => outsideManagementTest(),
    promoteRecord: () => outsideManagementTest(),
    promoteRecordForDissemination: () => outsideManagementTest(),
    applyCatchUpRecord: () => outsideManagementTest(),
    stageReanchor: () => outsideManagementTest(),
    completeReanchor: () => outsideManagementTest(),
    applyCatchUpReanchor: () => outsideManagementTest(),
    readPendingDeliveries: () => outsideManagementTest(),
    acknowledgeDelivery: () => outsideManagementTest(),
    enqueueOutbound: () => outsideManagementTest(),
    enqueueDisseminationOutbound: () => outsideManagementTest(),
    beginOutbound: () => outsideManagementTest(),
    replaceOutbound: () => outsideManagementTest(),
    completeOutbound: () => outsideManagementTest(),
    discardOutbound: () => outsideManagementTest(),
    restartEmptyConversation: () => outsideManagementTest(),
    searchConversations: () => outsideManagementTest(),
    readConversation: () =>
      input.historyFailure === undefined
        ? Effect.succeed({ records: [], continuation: null })
        : Effect.fail(input.historyFailure),
    releaseContinuation: () => outsideManagementTest(),
    recover: () => Effect.succeed(input.recovery),
  };
}

function makeRegistryLayer(cards: readonly VerifiedAgentCard[]) {
  const lookup = (
    request: Parameters<Context.Tag.Service<typeof Registry>["lookup"]>[0],
  ): RegistryLookupResult => {
    const card = cards.find((candidate) =>
      "agentName" in request
        ? candidate.agentName === request.agentName
        : candidate.agentId === request.agentId,
    );
    return card === undefined
      ? { kind: "not_found" }
      : { kind: "found", agentCard: card };
  };
  const service: Context.Tag.Service<typeof Registry> = {
    register: () => outsideManagementTest(),
    lookup: (request) => Effect.succeed(lookup(request)),
    list: () =>
      Effect.succeed({ kind: "page", agentCards: cards, hasMore: false }),
  };
  return Layer.succeed(Registry, service);
}

// @agent-code-guard/regression-only: these cases pin the addressed owner-management contract.
describe("addressed daemon management", () => {
  it("pages canonical addresses without exposing conversation identity", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeIdentityFixture;
        const recovery = yield* makeRecovery(fixture);
        const operations = yield* makeDaemonManagementOperations({
          store: makeStore({ recovery }),
          bootstrap: fixture.bootstrap,
        }).pipe(Effect.provide(makeRegistryLayer(fixture.cards)));

        expect(yield* operations.searchConversations({})).toEqual({
          kind: "page",
          addresses: ["agent:bob"],
          hasMore: false,
        });
      }),
    ));

  it("maps a missing certified history to history-gap", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeIdentityFixture;
        const recovery = yield* makeRecovery(fixture);
        const operations = yield* makeDaemonManagementOperations({
          store: makeStore({
            recovery,
            historyFailure: new EndpointStoreError({ reason: "not-found" }),
          }),
          bootstrap: fixture.bootstrap,
        }).pipe(Effect.provide(makeRegistryLayer(fixture.cards)));
        const request = Schema.decodeUnknownSync(
          managementReadConversationRequestSchema,
        )({ address: "agent:bob" });

        const error = yield* operations
          .readConversation(request)
          .pipe(Effect.flip);

        expect(error).toMatchObject({ reason: "history-gap" });
      }),
    ));
});

// @agent-code-guard/regression-only: the wire schema rejects retired identifiers and noncanonical pages.
describe("management address schemas", () => {
  it("accepts canonical address cursors and rejects retired fields", () => {
    expect(
      Schema.decodeUnknownSync(managementSearchConversationsRequestSchema)({
        afterAddress: "agent:bob",
      }),
    ).toEqual({ afterAddress: "agent:bob" });
    expect(() =>
      Schema.decodeUnknownSync(managementSearchConversationsRequestSchema)({
        afterConversationId: hash("cnv_", 1),
      }),
    ).toThrow();
  });

  it("requires strictly ordered address pages", () => {
    expect(
      Schema.decodeUnknownSync(managementSearchConversationsResultSchema)({
        kind: "page",
        addresses: ["agent:bob", "group:alice,bob,carol"],
        hasMore: false,
      }),
    ).toEqual({
      kind: "page",
      addresses: ["agent:bob", "group:alice,bob,carol"],
      hasMore: false,
    });
    expect(() =>
      Schema.decodeUnknownSync(managementSearchConversationsResultSchema)({
        kind: "page",
        addresses: ["group:alice,bob,carol", "agent:bob"],
        hasMore: false,
      }),
    ).toThrow();
  });
});
