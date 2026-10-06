/** @file Canonical addressed management projection, closed failures, and the register tool's cancellation and Registry deadline. */

import { FileSystem, HttpClient } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
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
import {
  type Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DaemonBootstrap } from "./bootstrap.js";
import {
  digest,
  issueTestCard,
  makeTestAuthority,
} from "../__tests__/agent-card-fixtures.js";
import {
  buildCertifiedGenesis,
  storeCertifiedGenesis,
  withGenesisAnchorSelecting,
  withMisattributedActionEvidence,
} from "../__tests__/certified-history-fixtures.js";
import { routerInstanceId } from "../__tests__/router-worker-fixtures.js";
import { unusedEndpointStore } from "../__tests__/unused-endpoint-store.js";
import {
  managementReadConversationRequestSchema,
  managementRegisterRequestSchema,
} from "../endpoint/mcp/owner-tools.js";
import {
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
  type IdentityBinding,
  openEndpointStore,
} from "../store/index.js";
import { verifyStoredMembership } from "../transport/messaging/index.js";
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
  readonly remoteAuthority: AgentSigningAuthority;
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
  return {
    bootstrap,
    cards: [local, remote],
    remoteAuthority,
  } satisfies IdentityFixture;
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

/**
 * A real endpoint store holding one certified record bob authored in his
 * direct conversation with alice, with the management view of alice.
 */
const makeCertifiedHistory = Effect.gen(function* () {
  const fixture = yield* makeIdentityFixture;
  const membership = yield* makeDirectMembership(fixture).pipe(
    Effect.flatMap((row) =>
      verifyStoredMembership(
        row,
        fixture.bootstrap.configuration.registrySignerPublicKey,
      ),
    ),
    Effect.orDie,
  );
  const record = yield* buildCertifiedGenesis(
    { card: fixture.cards[0], authority: fixture.bootstrap.signingAuthority },
    { card: fixture.cards[1], authority: fixture.remoteAuthority },
    membership,
    routerInstanceId(8),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const store = yield* openEndpointStore(
    yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-management-",
    }),
  ).pipe(Effect.orDie);
  yield* storeCertifiedGenesis(store, fixture.cards[0], membership, record);
  return { fixture, store, record };
}).pipe(Effect.provide(NodeFileSystem.layer));

/** Alice's first history page of her conversation with bob over `store`. */
const readBobHistory = (fixture: IdentityFixture, store: EndpointStore) =>
  makeDaemonManagementOperations({
    store,
    bootstrap: fixture.bootstrap,
    registration: activeRegistration(fixture.cards[0]),
  }).pipe(
    Effect.provide(makeRegistryLayer(fixture.cards)),
    Effect.flatMap((operations) =>
      operations.readConversation(
        Schema.decodeUnknownSync(managementReadConversationRequestSchema)({
          address: "agent:bob",
        }),
      ),
    ),
  );

/** The record hashes of alice's read of her conversation with bob over `store`. */
const readBobRecordHashes = (fixture: IdentityFixture, store: EndpointStore) =>
  readBobHistory(fixture, store).pipe(
    Effect.map((page) => page.records.map((record) => record.recordHash)),
    Effect.exit,
  );

/** A signer message's JWS representation, read as far as its one signature. */
const jwsSignature = Schema.Struct({
  signatures: Schema.Tuple(Schema.Struct({ signature: Schema.String })),
});

/**
 * The audit entry the owner tools return for one certificate signature:
 * `signer`'s AgentId and the signature its JWS `representation` carries.
 */
const signerEvidence = (
  signer: VerifiedAgentCard,
  representation: unknown,
) => ({
  signerAgentId: signer.agentId,
  signature:
    Schema.decodeUnknownSync(jwsSignature)(representation).signatures[0]
      .signature,
});

/**
 * `store` as it reads once its membership rows name `membershipHash`, so the
 * rows' columns no longer match the descriptors they hold.
 */
function withMembershipRowsNaming(
  store: EndpointStore,
  membershipHash: string,
): EndpointStore {
  return {
    ...store,
    recover: () =>
      store.recover().pipe(
        Effect.map((recovery) => ({
          ...recovery,
          memberships: recovery.memberships.map((row) => ({
            ...row,
            membershipHash,
          })),
        })),
      ),
  };
}

/**
 * The owner read returns the record with the anchor it commits to and, for
 * each certificate, every signer's AgentId with the signature its JWS
 * representation carries, in AgentId order.
 */
const returnsCertificateSignersForAudit = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { fixture, store, record } = yield* makeCertifiedHistory;
        const [alice, bob] = fixture.cards;
        const certified = record.actionCertifiedRecord;
        const signatures = certified.actionCertificate.signatures;
        const votes = record.durabilityCertificate.votes;

        const page = yield* readBobHistory(fixture, store);

        expect(
          compareAgentIds(alice.agentId, bob.agentId),
          "alice precedes bob in AgentId order",
        ).toBeLessThan(0);
        expect(page.records, "alice's history with bob").toEqual([
          {
            recordHash: certified.recordHash,
            recordCore: certified.recordCore,
            routerAnchor: certified.routerAnchor,
            actionSignatures: [
              signerEvidence(alice, signatures[0]),
              signerEvidence(bob, signatures[1]),
            ],
            durabilityVotes: [
              signerEvidence(alice, votes[0]),
              signerEvidence(bob, votes[1]),
            ],
          },
        ]);
      }),
    ),
  );

/**
 * A store whose membership row names a membership hash other than the one
 * its descriptor hashes to is corrupt, so the read reports
 * persistence-failed, while the unaltered store reads the record.
 */
const failsReadOverMembershipRowNamingAnotherHash = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { fixture, store, record } = yield* makeCertifiedHistory;
        const inconsistent = withMembershipRowsNaming(store, digest("mbr_", 9));

        const unaltered = yield* readBobRecordHashes(fixture, store);
        const corrupt = yield* readBobRecordHashes(fixture, inconsistent);

        expect(unaltered, "history read over the unaltered store").toEqual(
          Exit.succeed([record.actionCertifiedRecord.recordHash]),
        );
        expect(
          corrupt,
          "history read over the inconsistent membership row",
        ).toEqual(
          Exit.fail(expect.objectContaining({ reason: "persistence-failed" })),
        );
      }),
    ),
  );

/**
 * The owner tools read stored history with the row checks startup applies.
 * A store whose action evidence row is filed under a member other than its
 * signer is corrupt, so the read reports persistence-failed, while the
 * unaltered store reads the record.
 */
const failsReadOverMisattributedEvidence = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { fixture, store, record } = yield* makeCertifiedHistory;
        const misattributed = withMisattributedActionEvidence(
          store,
          fixture.cards[0].agentId,
          fixture.cards[1].agentId,
        );

        const unaltered = yield* readBobRecordHashes(fixture, store);
        const corrupt = yield* readBobRecordHashes(fixture, misattributed);

        expect(unaltered, "history read over the unaltered store").toEqual(
          Exit.succeed([record.actionCertifiedRecord.recordHash]),
        );
        expect(corrupt, "history read over the misattributed evidence").toEqual(
          Exit.fail(expect.objectContaining({ reason: "persistence-failed" })),
        );
      }),
    ),
  );

/**
 * A store whose genesis anchor row claims to select a record, which only a
 * completed re-anchor does, is corrupt, so the read reports
 * persistence-failed, while the unaltered store reads the record.
 */
const failsReadOverGenesisAnchorSelectingRecord = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { fixture, store, record } = yield* makeCertifiedHistory;
        const recordHash = record.actionCertifiedRecord.recordHash;
        const inconsistent = withGenesisAnchorSelecting(store, recordHash);

        const unaltered = yield* readBobRecordHashes(fixture, store);
        const corrupt = yield* readBobRecordHashes(fixture, inconsistent);

        expect(unaltered, "history read over the unaltered store").toEqual(
          Exit.succeed([recordHash]),
        );
        expect(
          corrupt,
          "history read over the inconsistent anchor row",
        ).toEqual(
          Exit.fail(expect.objectContaining({ reason: "persistence-failed" })),
        );
      }),
    ),
  );

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

describe("owner history read over stored rows", () => {
  it(
    "returns each certificate's signers and signatures with the record's anchor",
    returnsCertificateSignersForAudit,
  );
  it(
    "fails a history read whose action evidence is filed under another signer",
    failsReadOverMisattributedEvidence,
  );
  it(
    "fails a history read whose genesis anchor row selects a record",
    failsReadOverGenesisAnchorSelectingRecord,
  );
  it(
    "fails a history read whose membership row names another membership hash",
    failsReadOverMembershipRowNamingAnotherHash,
  );
});

/** What a register call left behind: the bound identity rows and activations. */
interface RegistrationEffects {
  readonly bound: Ref.Ref<readonly IdentityBinding[]>;
  readonly activated: Ref.Ref<readonly VerifiedAgentCard[]>;
}

const makeRegistrationEffects: Effect.Effect<RegistrationEffects> = Effect.all({
  bound: Ref.make<readonly IdentityBinding[]>([]),
  activated: Ref.make<readonly VerifiedAgentCard[]>([]),
});

/**
 * Management for an unregistered daemon whose store records each identity
 * bind and whose registration port records each activation.
 */
function makeRegisteringOperations(
  fixture: IdentityFixture,
  effects: RegistrationEffects,
) {
  return makeDaemonManagementOperations({
    store: {
      ...unusedEndpointStore("management registration test"),
      bindIdentity: (binding) =>
        Ref.update(effects.bound, (rows) => [...rows, binding]).pipe(
          Effect.as("inserted" as const),
        ),
    },
    bootstrap: fixture.bootstrap,
    registration: {
      readRegistration: () => ({ kind: "unregistered" }) as const,
      activateRegistered: (card) =>
        Ref.update(effects.activated, (cards) => [...cards, card]),
    },
  });
}

/** The register tool request for the fixture's local card. */
function localRegisterRequest(fixture: IdentityFixture) {
  return Schema.decodeUnknownSync(managementRegisterRequestSchema)({
    operationId: "opn_AAAAAAAAAAAAAAAAAAAAAA",
    principalId: fixture.cards[0].principalId,
    agentName: fixture.cards[0].agentName,
  });
}

/**
 * The production Registry client with a 1 s request deadline over an HTTP
 * client that completes `requested` when a request arrives and never answers,
 * as a stalled Registry connection behaves.
 */
function silentRegistryLayer(
  fixture: IdentityFixture,
  requested: Deferred.Deferred<undefined>,
) {
  return Registry.layer({
    origin: fixture.bootstrap.configuration.registryOrigin,
    registrySignerPublicKey:
      fixture.bootstrap.configuration.registrySignerPublicKey,
    requestTimeout: Duration.seconds(1),
  }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Deferred.succeed(requested, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
        ),
      ),
    ),
  );
}

/**
 * The register tool runs uninterruptibly so a cancelled request still binds.
 * That region must not also hold the Registry client's deadline off: a
 * Registry that never answers ends the call at the deadline, not never. The
 * deadline covers request signing too, so it is long enough for signing to
 * reach the HTTP client on a loaded machine. The register runs detached so a
 * masked call that never ends fails this test at its own bound instead of
 * holding the test fiber open.
 */
const failsAtTheRegistryDeadline = () =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const effects = yield* makeRegistrationEffects;
    const requested = yield* Deferred.make<undefined>();
    const operations = yield* makeRegisteringOperations(fixture, effects).pipe(
      Effect.provide(silentRegistryLayer(fixture, requested)),
    );
    const registration = yield* Effect.forkDaemon(
      operations.register(localRegisterRequest(fixture)),
    );

    const error = yield* Fiber.join(registration).pipe(
      Effect.flip,
      Effect.timeoutFail({
        duration: Duration.seconds(3),
        onTimeout: () => "register outlived the Registry deadline",
      }),
    );

    expect(yield* Deferred.isDone(requested)).toBe(true);
    expect(error).toMatchObject({ reason: "dependency-unavailable" });
    expect(yield* Ref.get(effects.bound)).toEqual([]);
    expect(yield* Ref.get(effects.activated)).toEqual([]);
  }).pipe(Effect.runPromise);

/** A Registry whose register waits for `release` after signalling `entered`. */
function heldRegistry(
  fixture: IdentityFixture,
  entered: Deferred.Deferred<undefined>,
  release: Deferred.Deferred<undefined>,
) {
  const service: Context.Tag.Service<typeof Registry> = {
    register: () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.zipRight(Deferred.await(release)),
        Effect.as({ kind: "registered", agentCard: fixture.cards[0] } as const),
      ),
    lookup: () => outsideManagementTest(),
    list: () => outsideManagementTest(),
  };
  return Layer.succeed(Registry, service);
}

/**
 * Cancelling the MCP request interrupts the tool's operation. One that
 * arrives while the Registry call is in flight must still let the call
 * finish, bind the card and activate it, or the Registry would hold a
 * registration this daemon never recorded. The zero-length sleep lets the
 * interrupt reach the register fiber before the Registry call is released.
 */
const bindsWhenCancelledDuringTheRegistryCall = () =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const effects = yield* makeRegistrationEffects;
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const operations = yield* makeRegisteringOperations(fixture, effects).pipe(
      Effect.provide(heldRegistry(fixture, entered, release)),
    );
    const registration = yield* Effect.fork(
      operations.register(localRegisterRequest(fixture)),
    );
    yield* Deferred.await(entered);
    const interruption = yield* Effect.fork(Fiber.interrupt(registration));
    yield* Effect.sleep(Duration.zero);
    yield* Deferred.succeed(release, undefined);

    expect(Exit.isInterrupted(yield* Fiber.join(interruption))).toBe(true);

    const canonicalAgentCard = yield* encodeCanonical(
      AgentCard,
      fixture.cards[0],
    );
    expect(yield* Ref.get(effects.bound)).toEqual([
      { agentId: fixture.cards[0].agentId, canonicalAgentCard },
    ]);
    expect(yield* Ref.get(effects.activated)).toEqual([fixture.cards[0]]);
  }).pipe(Effect.runPromise);

// @agent-code-guard/regression-only: these cases pin the register tool's cancellation and Registry deadline contract.
describe("daemon registration through the register tool", () => {
  it(
    "fails a register at the Registry deadline when the Registry never answers",
    failsAtTheRegistryDeadline,
  );
  it(
    "binds and activates a register cancelled during the Registry call",
    bindsWhenCancelledDuringTheRegistryCall,
  );
});
