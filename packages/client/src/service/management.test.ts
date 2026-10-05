/** @file Canonical addressed management projection and closed failures. */

import {
  AgentCard,
  AgentSigningAuthority,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import {
  Registry,
  type RegistryLookupResult,
} from "@moltzap/identity/registry";
import { type Context, Effect, Layer, Redacted, Schema } from "effect";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DaemonBootstrap } from "./bootstrap.js";
import {
  digest,
  issueTestCard,
  makeTestAuthority,
} from "../__tests__/agent-card-fixtures.js";
import { unusedEndpointStore } from "../__tests__/unused-endpoint-store.js";
import { managementReadConversationRequestSchema } from "../endpoint/mcp/owner-tools.js";
import {
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
} from "../store/index.js";
import {
  compareAgentIds,
  deriveConversationId,
  encodeCanonical,
  hashMembershipDescriptor,
  MembershipDescriptor,
} from "../transport/wire/index.js";
import { makeDaemonManagementOperations } from "./management.js";

interface IdentityFixture {
  readonly bootstrap: DaemonBootstrap;
  readonly cards: readonly [VerifiedAgentCard, VerifiedAgentCard];
}

const makeIdentityFixture = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const localAuthority = yield* makeTestAuthority();
  const remoteAuthority = yield* makeTestAuthority();
  const local = yield* issueTestCard({
    byte: 1,
    name: "alice",
    authority: localAuthority,
    registryKeys,
  });
  const remote = yield* issueTestCard({
    byte: 2,
    name: "bob",
    authority: remoteAuthority,
    registryKeys,
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
    admissionCredential: Effect.succeed(Redacted.make("bootstrap-token=")),
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
          currentAnchorHash: digest("anc_", 3),
          headRecordHash: digest("rch_", 4),
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

interface StoreInput {
  readonly recovery: EndpointRecovery;
  readonly historyFailure?: EndpointStoreError;
}

function makeStore(input: StoreInput): EndpointStore {
  return {
    ...unusedEndpointStore("management test"),
    readIdentity: () => Effect.succeed(input.recovery.identity),
    readConversation: () =>
      input.historyFailure === undefined
        ? Effect.succeed({ records: [], continuation: null })
        : Effect.fail(input.historyFailure),
    recover: () => Effect.succeed(input.recovery),
  };
}

/** The daemon's registration port, active with `card` and never activating. */
function activeRegistration(card: VerifiedAgentCard) {
  return {
    readRegistration: () => ({ kind: "active", agentCard: card }) as const,
    activateRegistered: () => Effect.void,
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
          registration: activeRegistration(fixture.cards[0]),
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
          registration: activeRegistration(fixture.cards[0]),
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
