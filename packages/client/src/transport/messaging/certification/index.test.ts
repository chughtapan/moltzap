/** @file Real N4 fixed-post certification through four durable endpoint engines. */

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
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Queue,
  Ref,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
  TestContext,
} from "effect";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AddressRegistryPort } from "../address.js";
import { advanceClock } from "../../../__tests__/advance-clock.js";
import {
  digest,
  identifier,
  issueTestCard,
  makeTestAuthority,
  type RegistryKeyPair,
} from "../../../__tests__/agent-card-fixtures.js";
import { forwardStoredOutbound } from "../../../__tests__/forward-stored-outbound.js";
import { pollCursor as fixturePollCursor } from "../../../__tests__/router-worker-fixtures.js";
import { type EndpointStore, openEndpointStore } from "../../../store/index.js";
import {
  type RouterIngressDisposition,
  type RouterTailAnchor,
  RouterWorkerDiscontinuityError,
  type RouterWorkerIngress,
  type RouterWorkerSendError,
  RouterWorkerTransportError,
  RouterWorkerUnavailableError,
} from "../../router/index.js";
import {
  type ActionProposal,
  Content,
  ConversationId,
  type ConversationId as ConversationIdValue,
  decodeCanonical,
  decodeOuterBody,
  deriveConversationId,
  encodeCanonical,
  EvidenceStatement,
  hashAction,
  MembershipDescriptor,
  MembershipHash,
  type MembershipHash as MembershipHashValue,
  RecordCore,
  RecordHash,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  type VerifiedMembership,
  verifyMembershipDescriptor,
} from "../../wire/index.js";
import { MessageAddressInput } from "../../wire/values.js";
import { SendError } from "../errors.js";
import {
  type EndpointEngine,
  type EndpointEngineInput,
  EngineInitializationError,
  type EngineOutboundError,
  type EngineSendInput,
  type EngineSentPost,
  makeEndpointEngine,
} from "../index.js";

/* eslint-disable max-lines, max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- The full protocol traces share one four-endpoint harness and keep controlled Router phases beside durable assertions. */

/** The Router-worker operations an engine consumes. */
type EngineRouterPort = EndpointEngineInput["routerWorker"];

interface ProtocolIdentity {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthority;
}

interface ProtocolHarness {
  readonly identities: readonly ProtocolIdentity[];
  readonly engines: readonly EndpointEngine[];
  readonly stores: readonly EndpointStore[];
  readonly membership: VerifiedMembership;
  readonly outbound: Queue.Queue<typeof SignedMessage.Type>;
  readonly groupAddress: string;
  readonly deliver: (
    messages: ReadonlyArray<typeof SignedMessage.Type>,
    endpointIndexes?: readonly number[],
  ) => Effect.Effect<readonly RouterIngressDisposition[]>;
  readonly drain: (endpointIndexes?: readonly number[]) => Effect.Effect<void>;
  readonly registry: AddressRegistryPort;
  readonly registrySignerPublicKey: typeof Ed25519PublicKey.Type;
}

const MEMBER_COUNT = 4;
const TEST_TIMEOUT_MS = 30_000;

const routerInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 31),
);
const pollCursor = fixturePollCursor(32);
const unrelatedConversationId = Schema.decodeUnknownSync(ConversationId)(
  digest("cnv_", 35),
);
const unrelatedMembershipHash = Schema.decodeUnknownSync(MembershipHash)(
  digest("mbr_", 36),
);
const unknownRecordHash = Schema.decodeUnknownSync(RecordHash)(
  digest("rch_", 37),
);
const endpointIndexes = Object.freeze([0, 1, 2, 3]);

function makeIdentities(registryKeys: RegistryKeyPair) {
  return Effect.forEach(
    endpointIndexes,
    (index) =>
      Effect.gen(function* () {
        const authority = yield* makeTestAuthority();
        return {
          card: yield* issueTestCard({
            byte: index + 1,
            name: `protocol-member-${index + 1}`,
            authority,
            registryKeys,
          }),
          authority,
        } satisfies ProtocolIdentity;
      }),
    { concurrency: 1 },
  );
}

function makeMembership(
  identities: readonly ProtocolIdentity[],
  registrySignerPublicKey: typeof Ed25519PublicKey.Type,
): Effect.Effect<VerifiedMembership> {
  return Effect.gen(function* () {
    const memberAgentIds = identities.map(({ card }) => card.agentId);
    const firstAgentId = memberAgentIds[0];
    const secondAgentId = memberAgentIds[1];
    if (firstAgentId === undefined || secondAgentId === undefined) {
      return yield* Effect.dieMessage("N4 membership is incomplete");
    }
    const conversationId = yield* deriveConversationId([
      firstAgentId,
      secondAgentId,
      ...memberAgentIds.slice(2),
    ]);
    const encodedCards = yield* Effect.forEach(
      identities,
      ({ card }) => Schema.encode(AgentCard)(card),
      { concurrency: 1 },
    );
    const firstCard = encodedCards[0];
    const secondCard = encodedCards[1];
    if (firstCard === undefined || secondCard === undefined) {
      return yield* Effect.dieMessage("N4 card encoding is incomplete");
    }
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "membership_descriptor",
      conversationId,
      members: [firstCard, secondCard, ...encodedCards.slice(2)],
    });
    return yield* verifyMembershipDescriptor(
      descriptor,
      registrySignerPublicKey,
    );
  }).pipe(Effect.orDie);
}

function lookupIdentity(
  identities: readonly ProtocolIdentity[],
  request: Parameters<AddressRegistryPort["lookup"]>[0],
): RegistryLookupResult {
  const found = identities.find(({ card }) =>
    "agentName" in request
      ? card.agentName === request.agentName
      : card.agentId === request.agentId,
  );
  return found === undefined
    ? { kind: "not_found" }
    : { kind: "found", agentCard: found.card };
}

function requireAt<Value>(
  values: readonly Value[],
  index: number,
  label: string,
): Effect.Effect<Value> {
  const value = values[index];
  return value === undefined
    ? Effect.dieMessage(`missing ${label} ${index}`)
    : Effect.succeed(value);
}

function decodeIngress(
  identities: readonly ProtocolIdentity[],
  message: typeof SignedMessage.Type,
): Effect.Effect<
  RouterWorkerIngress<Effect.Effect.Success<ReturnType<typeof decodeOuterBody>>>
> {
  return Effect.gen(function* () {
    const identity = identities.find(
      ({ card }) => card.agentId === message.senderAgentId,
    );
    if (identity === undefined) {
      return yield* Effect.dieMessage("unknown protocol sender");
    }
    const verifiedMessage = yield* SignedMessage.verify({
      signedMessage: message,
      agentCard: identity.card,
    });
    return {
      routerInstanceId,
      message: verifiedMessage,
      senderCard: identity.card,
      payload: yield* decodeOuterBody(message.body),
    };
  }).pipe(Effect.orDie);
}

function signEveryAction(): Effect.Effect<"sign"> {
  return Effect.succeed("sign");
}

type WorkerAttachment = Pick<EngineRouterPort, "awaitAnchor" | "currentAnchor">;

/** Replaces a worker's transmit, given the scripted Router forward. */
type WrapSend = (forward: EngineRouterPort["send"]) => EngineRouterPort["send"];

function attachesWhenResolved(
  attached: Deferred.Deferred<RouterTailAnchor>,
): WorkerAttachment {
  return {
    currentAnchor: Deferred.poll(attached).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new RouterWorkerUnavailableError()),
          onSome: (anchor: Effect.Effect<RouterTailAnchor>) => anchor,
        }),
      ),
    ),
    awaitAnchor: Deferred.await(attached),
  };
}

const neverAttaches: WorkerAttachment = {
  currentAnchor: Effect.fail(new RouterWorkerUnavailableError()),
  awaitAnchor: Effect.never,
};

function scriptedRouterWorker(
  store: EndpointStore,
  outbound: Queue.Queue<typeof SignedMessage.Type>,
  attachment?: WorkerAttachment,
  wrapSend?: WrapSend,
): EngineRouterPort {
  const anchor = { routerInstanceId, pollCursor };
  const forward = (outboundId: string) =>
    forwardStoredOutbound(store, outbound, outboundId);
  return {
    currentAnchor: attachment?.currentAnchor ?? Effect.succeed(anchor),
    awaitAnchor: attachment?.awaitAnchor ?? Effect.succeed(anchor),
    send: wrapSend === undefined ? forward : wrapSend(forward),
  };
}

function deliverIngress(
  engines: readonly EndpointEngine[],
  selectedIndexes: readonly number[],
  ingress: Effect.Effect.Success<ReturnType<typeof decodeIngress>>,
) {
  return Effect.forEach(
    selectedIndexes,
    (index) =>
      requireAt(engines, index, "endpoint engine").pipe(
        Effect.flatMap((engine) => engine.acceptRouterIngress(ingress)),
      ),
    { concurrency: 1 },
  );
}

function deliverMessages(
  identities: readonly ProtocolIdentity[],
  engines: readonly EndpointEngine[],
  messages: ReadonlyArray<typeof SignedMessage.Type>,
  selectedIndexes: readonly number[],
) {
  return Effect.forEach(
    messages,
    (message) =>
      decodeIngress(identities, message).pipe(
        Effect.flatMap((ingress) =>
          deliverIngress(engines, selectedIndexes, ingress),
        ),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((dispositions) => dispositions.flat()),
    Effect.orDie,
  );
}

function drainEngines(
  engines: readonly EndpointEngine[],
  selectedIndexes: readonly number[],
) {
  return Effect.forEach(
    selectedIndexes,
    (index) =>
      requireAt(engines, index, "endpoint engine").pipe(
        Effect.flatMap((engine) => engine.drainOutbound),
      ),
    { concurrency: 1, discard: true },
  ).pipe(Effect.orDie);
}

interface HarnessOptions {
  readonly actionPolicy?: EndpointEngineInput["actionPolicy"];
  /** Present when the author's Router worker has not attached yet. */
  readonly attachment?: WorkerAttachment;
  /** Replaces the author's worker transmit. */
  readonly authorSend?: WrapSend;
}

function makeProtocolHarness(
  options: HarnessOptions = {},
): Effect.Effect<ProtocolHarness, never, Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const registryKeys = generateKeyPairSync("ed25519");
    const registrySignerPublicKey = yield* Schema.decodeUnknown(
      Ed25519PublicKey,
    )(registryKeys.publicKey.export({ format: "jwk" }));
    const identities = yield* makeIdentities(registryKeys);
    const membership = yield* makeMembership(
      identities,
      registrySignerPublicKey,
    );
    const stores = yield* Effect.forEach(
      endpointIndexes,
      (index) =>
        fileSystem
          .makeTempDirectoryScoped({
            prefix: `moltzap-engine-protocol-${index}-`,
          })
          .pipe(Effect.flatMap(openEndpointStore)),
      { concurrency: 1 },
    );
    const outbound = yield* Queue.unbounded<typeof SignedMessage.Type>();
    const registry: AddressRegistryPort = {
      lookup: (request) => Effect.succeed(lookupIdentity(identities, request)),
    };
    const engines = yield* Effect.forEach(
      identities,
      (identity, index) =>
        requireAt(stores, index, "endpoint store").pipe(
          Effect.flatMap((store) =>
            makeEndpointEngine({
              localAgentCard: identity.card,
              signingAuthority: identity.authority,
              registrySignerPublicKey,
              registry,
              store,
              actionPolicy:
                index === 0
                  ? (options.actionPolicy ?? signEveryAction)
                  : signEveryAction,
              routerWorker: scriptedRouterWorker(
                store,
                outbound,
                index === 0 ? options.attachment : undefined,
                index === 0 ? options.authorSend : undefined,
              ),
            }),
          ),
        ),
      { concurrency: 1 },
    );
    const deliver: ProtocolHarness["deliver"] = (
      messages,
      selectedIndexes = endpointIndexes,
    ) => deliverMessages(identities, engines, messages, selectedIndexes);
    const drain: ProtocolHarness["drain"] = (
      selectedIndexes = endpointIndexes,
    ) => drainEngines(engines, selectedIndexes);
    return {
      identities,
      engines,
      stores,
      membership,
      outbound,
      groupAddress: `group:${identities.map(({ card }) => card.agentName).join(",")}`,
      deliver,
      drain,
      registry,
      registrySignerPublicKey,
    } satisfies ProtocolHarness;
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie);
}

function sendInput(
  harness: ProtocolHarness,
  text: string,
  to?: string,
): Effect.Effect<EngineSendInput> {
  return Effect.all({
    to: Schema.decodeUnknown(MessageAddressInput)(to ?? harness.groupAddress),
    content: Schema.decodeUnknown(Content)([{ type: "text", text }]),
  }).pipe(Effect.orDie);
}

function takeReadyBatch(harness: ProtocolHarness) {
  return Queue.take(harness.outbound).pipe(
    Effect.timeout("1 second"),
    Effect.flatMap((first) =>
      Queue.takeAll(harness.outbound).pipe(
        Effect.map((remaining) => [first, ...remaining]),
      ),
    ),
    Effect.orDie,
  );
}

function takeQueued(harness: ProtocolHarness) {
  return Queue.takeAll(harness.outbound).pipe(
    Effect.map((messages) => Array.from(messages)),
  );
}

function protocolMessageKind(
  message: typeof SignedMessage.Type,
): Effect.Effect<string> {
  return decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) =>
      body.kind === "direct"
        ? Effect.succeed(body.packet.kind)
        : decodeCanonical(EvidenceStatement, body.message.body).pipe(
            Effect.map((statement) => statement.kind),
          ),
    ),
    Effect.orDie,
  );
}

function messagesOfKind(
  messages: ReadonlyArray<typeof SignedMessage.Type>,
  kind: string,
) {
  return Effect.forEach(
    messages,
    (message) =>
      protocolMessageKind(message).pipe(
        Effect.map((actualKind) => ({ actualKind, message })),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((classified) =>
      classified
        .filter(({ actualKind }) => actualKind === kind)
        .map(({ message }) => message),
    ),
  );
}

function decodeActionProposal(
  message: typeof SignedMessage.Type,
): Effect.Effect<ActionProposal> {
  return decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) =>
      body.kind === "direct" && body.packet.kind === "action_proposal"
        ? Effect.succeed(body.packet)
        : Effect.dieMessage("expected action proposal"),
    ),
    Effect.orDie,
  );
}

function decodeActionSignatureHash(
  message: typeof SignedMessage.Type,
): Effect.Effect<Effect.Effect.Success<ReturnType<typeof hashAction>>> {
  return decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) =>
      body.kind === "evidence"
        ? decodeCanonical(EvidenceStatement, body.message.body)
        : Effect.dieMessage("expected evidence envelope"),
    ),
    Effect.flatMap((statement) =>
      statement.kind === "action_signature"
        ? Effect.succeed(statement.actionHash)
        : Effect.dieMessage("expected action signature"),
    ),
    Effect.orDie,
  );
}

/**
 * Deliver a batch to the online engines, drain each, and repeat with whatever
 * they queued, until a round queues nothing. An exchange still producing
 * traffic after 32 rounds is a defect in the scripted Router, so it dies.
 * @param harness Engines and the scripted Router queue they send through.
 * @param initial First batch to deliver.
 * @param online Engines that receive and send; every engine when omitted.
 * @returns Every message delivered, in Router order, once the exchange is idle.
 */
function pump(
  harness: ProtocolHarness,
  initial: ReadonlyArray<typeof SignedMessage.Type>,
  online?: readonly number[],
): Effect.Effect<ReadonlyArray<typeof SignedMessage.Type>> {
  return Effect.gen(function* () {
    const delivered: Array<typeof SignedMessage.Type> = [];
    let batch = initial;
    for (let round = 0; round < 32; round += 1) {
      if (batch.length === 0) {
        return delivered;
      }
      yield* harness.deliver(batch, online);
      yield* harness.drain(online);
      delivered.push(...batch);
      batch = yield* takeQueued(harness);
    }
    return yield* Effect.dieMessage("scripted Router did not become idle");
  });
}

function certifyGenesisOf(
  harness: ProtocolHarness,
  sending: Fiber.RuntimeFiber<EngineSentPost, SendError>,
): Effect.Effect<RecordHash> {
  return Effect.gen(function* () {
    const initial = yield* takeReadyBatch(harness);
    const proposalMessage = yield* requireAt(initial, 0, "genesis proposal");
    const proposal = yield* decodeActionProposal(proposalMessage);
    if (proposal.action.kind !== "GENESIS") {
      return yield* Effect.dieMessage("first addressed send was not GENESIS");
    }
    yield* pump(harness, initial);
    const recoveries = yield* Effect.forEach(
      harness.stores,
      (store) => store.recover().pipe(Effect.orDie),
      { concurrency: 1 },
    );
    expect(
      recoveries.map(({ certifiedRecords }) => certifiedRecords.length),
    ).toEqual([1, 1, 1, 1]);
    const sent = yield* Fiber.join(sending).pipe(
      Effect.timeout("1 second"),
      Effect.orDie,
    );
    return sent.recordHash;
  });
}

function certifyGenesis(harness: ProtocolHarness): Effect.Effect<RecordHash> {
  return Effect.gen(function* () {
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "open group")),
    );
    return yield* certifyGenesisOf(harness, sending);
  });
}

/**
 * Tests read a staged POST's hash from the store because no member sends the
 * record it assembles.
 * @param store Endpoint store holding a staged GENESIS and one staged POST.
 * @returns The hash that durability votes for that POST name.
 */
function stagedPostRecordHash(store: EndpointStore): Effect.Effect<RecordHash> {
  return store.recover().pipe(
    Effect.map(({ stagedRecords }) =>
      stagedRecords.find(
        ({ previousRecordHash }) => previousRecordHash !== undefined,
      ),
    ),
    Effect.flatMap((staged) =>
      staged === undefined
        ? Effect.dieMessage("no POST record was staged")
        : Schema.decodeUnknown(RecordHash)(staged.recordHash),
    ),
    Effect.orDie,
  );
}

function hostileDurabilityMessage(input: {
  readonly harness: ProtocolHarness;
  readonly signer: ProtocolIdentity;
  readonly recordHash: RecordHash;
  readonly conversationId: ConversationIdValue;
  readonly membershipHash: MembershipHashValue;
}) {
  return signEvidenceMessage({
    statement: {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "durability_vote",
      signerAgentId: input.signer.card.agentId,
      conversationId: input.conversationId,
      membershipHash: input.membershipHash,
      recordHash: input.recordHash,
    },
    agentCard: input.signer.card,
    signingAuthority: input.signer.authority,
  }).pipe(
    Effect.flatMap((evidence) =>
      signOuterEvidence({
        evidence,
        membership: input.harness.membership,
        agentCard: input.signer.card,
        signingAuthority: input.signer.authority,
      }),
    ),
    Effect.orDie,
  );
}

/** The conversation and membership a durability vote is signed over. */
interface DurabilityBinding {
  readonly conversationId: ConversationIdValue;
  readonly membershipHash: MembershipHashValue;
}

/**
 * Stages the author's successor POST up to its action certificate, persists
 * a durability vote from member 3 under `bind`'s binding in the author's
 * store, and restarts the author's engine over that store. The vote belongs
 * to no certified record, so only the staged fold's evidence recovery reads
 * it.
 * @param bind Chooses the vote's binding from the conversation's membership.
 * @param filedUnder The member whose AgentId keys the vote's row; the voter
 *   is member 3.
 * @returns `"started"`, or the error the restart failed with.
 */
function restartOverPersistedDurabilityVote(
  bind: (membership: VerifiedMembership) => DurabilityBinding,
  filedUnder: number,
): Effect.Effect<"started" | EngineInitializationError, never, Scope.Scope> {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    yield* certifyGenesis(harness);
    const author = yield* requireAt(harness.identities, 0, "identity");
    const voter = yield* requireAt(harness.identities, 3, "durability voter");
    const keyMember = yield* requireAt(
      harness.identities,
      filedUnder,
      "evidence key member",
    );
    const authorEngine = yield* requireAt(
      harness.engines,
      0,
      "endpoint engine",
    );
    const authorStore = yield* requireAt(harness.stores, 0, "endpoint store");
    const sending = yield* Effect.fork(
      authorEngine.send(yield* sendInput(harness, "stage successor")),
    );
    yield* harness.deliver(yield* takeReadyBatch(harness));
    yield* harness.drain();
    const actionSignatures = yield* messagesOfKind(
      yield* takeQueued(harness),
      "action_signature",
    );
    yield* harness.deliver(actionSignatures.slice(0, 3));
    yield* harness.drain();
    yield* takeQueued(harness);
    const recordHash = yield* stagedPostRecordHash(authorStore);
    const vote = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "durability_vote",
        signerAgentId: voter.card.agentId,
        ...bind(harness.membership),
        recordHash,
      },
      agentCard: voter.card,
      signingAuthority: voter.authority,
    }).pipe(Effect.orDie);
    yield* authorStore
      .mergeEvidence({
        conversationId: harness.membership.descriptor.conversationId,
        kind: "durability",
        subjectId: recordHash,
        evidenceKey: keyMember.card.agentId,
        canonicalEvidence: yield* encodeCanonical(SignedMessage, vote).pipe(
          Effect.orDie,
        ),
      })
      .pipe(Effect.orDie);
    yield* Fiber.interrupt(sending);

    return yield* makeEndpointEngine({
      localAgentCard: author.card,
      signingAuthority: author.authority,
      registrySignerPublicKey: harness.registrySignerPublicKey,
      registry: harness.registry,
      store: authorStore,
      actionPolicy: signEveryAction,
      routerWorker: scriptedRouterWorker(authorStore, harness.outbound),
    }).pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => "started" as const,
      }),
    );
  });
}

function certifiesOrdinaryN4Post() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const author = yield* requireAt(harness.identities, 0, "identity");
        const authorEngine = yield* requireAt(
          harness.engines,
          0,
          "endpoint engine",
        );
        const authorStore = yield* requireAt(
          harness.stores,
          0,
          "endpoint store",
        );

        const sending = yield* Effect.fork(
          authorEngine.send(yield* sendInput(harness, "ordinary post")),
        );
        const proposalBatch = yield* takeReadyBatch(harness);
        expect(proposalBatch).toHaveLength(1);
        const proposalMessage = yield* requireAt(
          proposalBatch,
          0,
          "POST proposal",
        );
        const proposal = yield* decodeActionProposal(proposalMessage);
        if (proposal.action.kind !== "POST") {
          return yield* Effect.dieMessage("ordinary send did not propose POST");
        }

        yield* harness.deliver(proposalBatch);
        yield* harness.drain();
        const signatureBatch = yield* takeQueued(harness);
        const actionSignatures = yield* messagesOfKind(
          signatureBatch,
          "action_signature",
        );
        expect(actionSignatures).toHaveLength(MEMBER_COUNT);

        yield* harness.deliver(actionSignatures.slice(0, 3));
        yield* harness.drain();
        const certificationBatch = yield* takeQueued(harness);
        const durabilityMessages = yield* messagesOfKind(
          certificationBatch,
          "durability_vote",
        );
        expect(durabilityMessages).toHaveLength(MEMBER_COUNT);
        expect(certificationBatch).toHaveLength(MEMBER_COUNT);

        const actionHash = yield* hashAction(proposal.action).pipe(
          Effect.orDie,
        );
        const recordHash = yield* stagedPostRecordHash(authorStore);
        const staged = yield* authorStore.recover().pipe(Effect.orDie);
        const actionSigners = staged.evidence
          .filter(
            ({ kind, subjectId }) =>
              kind === "action" && subjectId === actionHash,
          )
          .map(({ evidenceKey }) => evidenceKey);
        expect(actionSigners).toHaveLength(3);
        expect(actionSigners).toContain(author.card.agentId);
        expect(
          staged.certifiedRecords.some(
            (record) => record.recordHash === recordHash,
          ),
        ).toBe(false);
        expect(
          staged.evidence.filter(
            ({ kind, subjectId }) =>
              kind === "durability" && subjectId === recordHash,
          ),
        ).toHaveLength(1);

        const hostileSigner = yield* requireAt(
          harness.identities,
          3,
          "hostile signer",
        );
        const wrongConversationVote = yield* hostileDurabilityMessage({
          harness,
          signer: hostileSigner,
          recordHash,
          conversationId: unrelatedConversationId,
          membershipHash: harness.membership.hash,
        });
        const wrongMembershipVote = yield* hostileDurabilityMessage({
          harness,
          signer: hostileSigner,
          recordHash,
          conversationId: harness.membership.descriptor.conversationId,
          membershipHash: unrelatedMembershipHash,
        });
        expect(
          yield* harness.deliver(
            [wrongConversationVote, wrongMembershipVote],
            [0],
          ),
        ).toEqual(["ignored", "ignored"]);

        const afterHostileVotes = yield* authorStore
          .recover()
          .pipe(Effect.orDie);
        expect(
          afterHostileVotes.certifiedRecords.some(
            (record) => record.recordHash === recordHash,
          ),
        ).toBe(false);
        expect(
          afterHostileVotes.evidence.filter(
            ({ kind, subjectId }) =>
              kind === "durability" && subjectId === recordHash,
          ),
        ).toHaveLength(1);

        const remoteDurabilityVotes = durabilityMessages.filter(
          (message) => message.senderAgentId !== author.card.agentId,
        );
        expect(remoteDurabilityVotes).toHaveLength(3);
        const firstRemoteVote = yield* requireAt(
          remoteDurabilityVotes,
          0,
          "remote durability vote",
        );
        const secondRemoteVote = yield* requireAt(
          remoteDurabilityVotes,
          1,
          "remote durability vote",
        );
        expect(yield* harness.deliver([firstRemoteVote], [0])).toEqual([
          "accepted",
        ]);
        const afterFirstRemoteVote = yield* authorStore
          .recover()
          .pipe(Effect.orDie);
        expect(
          afterFirstRemoteVote.certifiedRecords.some(
            (record) => record.recordHash === recordHash,
          ),
        ).toBe(false);

        expect(yield* harness.deliver([secondRemoteVote], [0])).toEqual([
          "accepted",
        ]);
        yield* Fiber.join(sending).pipe(Effect.orDie);
        const certified = yield* authorStore.recover().pipe(Effect.orDie);
        const storedPost = certified.certifiedRecords.find(
          (record) => record.recordHash === recordHash,
        );
        if (storedPost === undefined) {
          return yield* Effect.dieMessage("POST did not complete durably");
        }
        expect(storedPost.actionEvidence).toHaveLength(3);
        expect(storedPost.durabilityEvidence).toHaveLength(3);
        const storedCore = yield* decodeCanonical(
          RecordCore,
          storedPost.canonicalRecordCore,
        ).pipe(Effect.orDie);
        expect(storedCore.action.kind).toBe(proposal.action.kind);
        expect(storedCore.actionHash).toBe(actionHash);
      }),
    ),
  );
}

/**
 * One N4 post, from proposal to every member's certified record, takes
 * 1 + 2n outer messages: the proposal, one action signature and one
 * durability vote from each member. Each member assembles both certified
 * records itself, so none is sent.
 * @returns Completion once the counted post is certified everywhere.
 */
function sendsOnePlusTwoNMessagesPerPost() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const author = yield* requireAt(harness.engines, 0, "endpoint engine");
        const sending = yield* Effect.fork(
          author.send(yield* sendInput(harness, "counted post")),
        );

        const delivered = yield* pump(harness, yield* takeReadyBatch(harness));
        yield* Fiber.join(sending).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );

        const kinds = yield* Effect.forEach(delivered, protocolMessageKind, {
          concurrency: 1,
        });
        expect(
          [...kinds].sort((left, right) => left.localeCompare(right)),
        ).toEqual([
          "action_proposal",
          "action_signature",
          "action_signature",
          "action_signature",
          "action_signature",
          "durability_vote",
          "durability_vote",
          "durability_vote",
          "durability_vote",
        ]);
      }),
    ),
  );
}

/**
 * Certifies the author's queued post while member 2 hears none of it.
 * @param harness Engines with one POST proposal queued.
 * @returns Completion once the post is certified at members 1, 3 and 4.
 */
function missesEveryMessage(harness: ProtocolHarness): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* pump(harness, yield* takeReadyBatch(harness), [0, 2, 3]);
  });
}

/**
 * Certifies the author's queued post while member 2 is offline for its
 * durability votes. Member 2 hears the proposal and the action signatures, so
 * it stages the record and sends its own vote, but never certifies it.
 * @param harness Engines with one POST proposal queued.
 * @returns Completion once the post is certified at members 1, 3 and 4.
 */
function missesDurabilityVotes(harness: ProtocolHarness): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* harness.deliver(yield* takeReadyBatch(harness));
    yield* harness.drain();
    yield* harness.deliver(yield* takeQueued(harness));
    yield* harness.drain();
    yield* pump(harness, yield* takeQueued(harness), [0, 2, 3]);
  });
}

/**
 * Member 2 misses one post as `certifyWithoutMember2` scripts. Member 4 is
 * then offline, so the next post needs member 2's signature and durability
 * vote. The next proposal names the record member 2 lacks: member 2 catches
 * it up from the members, accepts the proposal with the signatures that
 * arrived meanwhile, and the post certifies at every online member.
 * @param certifyWithoutMember2 Certifies one queued post without member 2.
 * @returns Completion once member 2 holds and delivers both posts.
 */
function laggingMemberCatchesUpAndCertifiesTheNextPost(
  certifyWithoutMember2: (harness: ProtocolHarness) => Effect.Effect<void>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const author = yield* requireAt(harness.engines, 0, "endpoint engine");
        const lagging = yield* requireAt(harness.engines, 1, "endpoint engine");
        const laggingStore = yield* requireAt(
          harness.stores,
          1,
          "endpoint store",
        );

        const missed = yield* Effect.fork(
          author.send(yield* sendInput(harness, "missed by member 2")),
        );
        yield* certifyWithoutMember2(harness);
        yield* Fiber.join(missed).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );
        const next = yield* Effect.fork(
          author.send(yield* sendInput(harness, "needs member 2")),
        );
        yield* pump(harness, yield* takeReadyBatch(harness), [0, 1, 2]);
        yield* Fiber.join(next).pipe(Effect.timeout("1 second"), Effect.orDie);

        const recovered = yield* laggingStore.recover().pipe(Effect.orDie);
        expect(recovered.certifiedRecords).toHaveLength(3);
        const pending = yield* lagging.readPendingMessages().pipe(Effect.orDie);
        expect(pending.map(({ message }) => message.content)).toEqual([
          [{ type: "text", text: "open group" }],
          [{ type: "text", text: "missed by member 2" }],
          [{ type: "text", text: "needs member 2" }],
        ]);
      }),
    ),
  );
}

/**
 * Member 4 is offline whenever member 2 asks for history, so member 2's
 * catch-up never completes. Member 2 misses one post, catches it up for the
 * next, then misses a third post. The fourth proposal names that post, and
 * member 2 asks for it although its earlier request is still unanswered, so
 * the fourth post certifies with its signature.
 * @returns Completion once member 2 holds and delivers all four posts.
 */
function asksForALaterGapWhileAMemberNeverAnswers() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const author = yield* requireAt(harness.engines, 0, "endpoint engine");
        const lagging = yield* requireAt(harness.engines, 1, "endpoint engine");
        const posts = [
          { text: "first missed by member 2", online: [0, 2, 3] },
          { text: "needs member 2", online: [0, 1, 2] },
          { text: "second missed by member 2", online: [0, 2, 3] },
          { text: "needs member 2 again", online: [0, 1, 2] },
        ];
        for (const { text, online } of posts) {
          const sending = yield* Effect.fork(
            author.send(yield* sendInput(harness, text)),
          );
          yield* pump(harness, yield* takeReadyBatch(harness), online);
          yield* Fiber.join(sending).pipe(
            Effect.timeout("1 second"),
            Effect.orDie,
          );
        }

        const pending = yield* lagging.readPendingMessages().pipe(Effect.orDie);
        expect(pending.map(({ message }) => message.content)).toEqual([
          [{ type: "text", text: "open group" }],
          ...posts.map(({ text }) => [{ type: "text", text }]),
        ]);
      }),
    ),
  );
}

/**
 * Members 1 and 2 propose at the same head. Member 1's post certifies, and
 * member 2 proposes again from the new head, before the Router delivers
 * member 2's first proposal. That proposal names a record every member
 * certified before its head, so every member ignores it and asks for no
 * catch-up.
 * @returns Completion once the stale proposal has been ignored everywhere.
 */
function ignoresAProposalNamingAPassedRecord() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const firstAuthor = yield* requireAt(
          harness.engines,
          0,
          "endpoint engine",
        );
        const secondAuthor = yield* requireAt(
          harness.engines,
          1,
          "endpoint engine",
        );
        const firstSending = yield* Effect.fork(
          firstAuthor.send(yield* sendInput(harness, "first candidate")),
        );
        const firstBatch = yield* takeReadyBatch(harness);
        const secondSending = yield* Effect.fork(
          secondAuthor.send(yield* sendInput(harness, "second candidate")),
        );
        const staleBatch = yield* takeReadyBatch(harness);
        yield* pump(harness, firstBatch);
        yield* Fiber.join(firstSending).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );
        yield* Fiber.join(secondSending).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );

        expect(yield* harness.deliver(staleBatch)).toEqual([
          "ignored",
          "ignored",
          "ignored",
          "ignored",
        ]);
        yield* harness.drain();
        expect(yield* takeQueued(harness)).toEqual([]);
      }),
    ),
  );
}

/**
 * Member 1 re-signs its queued POST proposal so that it names a predecessor
 * no member holds.
 * @param harness Engines whose identities sign the copy.
 * @param proposalBatch The batch holding member 1's POST proposal first.
 * @param membership Membership of the proposal's conversation, when it is not
 *   the harness's N4 conversation.
 * @returns The forged outer message.
 */
function forgeUnknownPredecessor(
  harness: ProtocolHarness,
  proposalBatch: ReadonlyArray<typeof SignedMessage.Type>,
  membership?: VerifiedMembership,
): Effect.Effect<typeof SignedMessage.Type> {
  return Effect.gen(function* () {
    const author = yield* requireAt(harness.identities, 0, "identity");
    const proposal = yield* decodeActionProposal(
      yield* requireAt(proposalBatch, 0, "POST proposal"),
    );
    if (proposal.action.kind !== "POST") {
      return yield* Effect.dieMessage("ordinary send did not propose POST");
    }
    return yield* signOuterPacket({
      packet: {
        ...proposal,
        action: { ...proposal.action, previousRecordHash: unknownRecordHash },
      },
      membership: membership ?? harness.membership,
      agentCard: author.card,
      signingAuthority: author.authority,
    }).pipe(Effect.orDie);
  });
}

/**
 * Member 2 asks for history after a forged proposal, and members 1, 3 and 4
 * answer that they hold nothing later. Before those answers reach member 2,
 * a post certifies without it, and the next proposal names that post while
 * member 4 is offline. Member 2 asks again only once the earlier answers are
 * in, so they do not complete the newer request, and it catches up the post
 * and signs the next one.
 * @returns Completion once member 2 holds and delivers both posts.
 */
function asksAgainAfterAnswersThatPredateTheNamedRecord() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const author = yield* requireAt(harness.engines, 0, "endpoint engine");
        const lagging = yield* requireAt(harness.engines, 1, "endpoint engine");
        const missed = yield* Effect.fork(
          author.send(yield* sendInput(harness, "missed by member 2")),
        );
        const missedBatch = yield* takeReadyBatch(harness);
        yield* harness.deliver(
          [yield* forgeUnknownPredecessor(harness, missedBatch)],
          [1],
        );
        yield* harness.drain([1]);
        yield* harness.deliver(yield* takeQueued(harness), [0, 2, 3]);
        yield* harness.drain([0, 2, 3]);
        const earlierAnswers = yield* takeQueued(harness);
        yield* pump(harness, missedBatch, [0, 2, 3]);
        yield* Fiber.join(missed).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );

        const next = yield* Effect.fork(
          author.send(yield* sendInput(harness, "needs member 2")),
        );
        const nextBatch = yield* takeReadyBatch(harness);
        yield* pump(harness, [...nextBatch, ...earlierAnswers], [0, 1, 2]);
        yield* Fiber.join(next).pipe(Effect.timeout("1 second"), Effect.orDie);

        const pending = yield* lagging.readPendingMessages().pipe(Effect.orDie);
        expect(pending.map(({ message }) => message.content)).toEqual([
          [{ type: "text", text: "open group" }],
          [{ type: "text", text: "missed by member 2" }],
          [{ type: "text", text: "needs member 2" }],
        ]);
      }),
    ),
  );
}

/**
 * A member's proposal naming a predecessor no member holds is ignored without
 * failing the endpoint. The endpoint asks the members for later history, every
 * member answers that it has none, and the conversation's next real post
 * certifies at every member.
 * @returns Completion once the real post is certified everywhere.
 */
function unresolvablePredecessorLeavesTheConversationLive() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const authorEngine = yield* requireAt(
          harness.engines,
          0,
          "endpoint engine",
        );
        const sending = yield* Effect.fork(
          authorEngine.send(yield* sendInput(harness, "real successor")),
        );
        const proposalBatch = yield* takeReadyBatch(harness);
        const forged = yield* forgeUnknownPredecessor(harness, proposalBatch);

        expect(yield* harness.deliver([forged], [1])).toEqual(["ignored"]);
        yield* harness.drain([1]);
        const requests = yield* takeQueued(harness);
        expect(
          yield* messagesOfKind(requests, "catch_up_request"),
        ).toHaveLength(1);
        yield* pump(harness, [...requests, ...proposalBatch]);
        yield* Fiber.join(sending).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );

        const histories = yield* Effect.forEach(
          harness.stores,
          (store) =>
            store
              .recover()
              .pipe(
                Effect.map(({ certifiedRecords }) => certifiedRecords.length),
              ),
          { concurrency: 1 },
        ).pipe(Effect.orDie);
        expect(histories).toEqual([2, 2, 2, 2]);
      }),
    ),
  );
}

/**
 * Member 2 misses one post. With member 4 offline, members 1 and 3 then
 * propose at the record member 2 lacks, and the Router orders member 1's
 * proposal first. Member 2 keeps that proposal, which members 1 and 3 locked,
 * and ignores member 3's, so after catch-up it signs member 1's post and then
 * member 3's proposal from the new head.
 *
 * Value: protects=a member lacking the named record keeps the first
 * Router-ordered proposal at that position and signs it after catch-up;
 * fails_when=a later proposal at the same position replaces the held one, so
 * the member signs a proposal no other member locked; why_new=other catch-up
 * tests deliver one proposal per lacked position; seam=none.
 * @returns Completion once member 2 holds and delivers every post.
 */
function keepsTheFirstProposalAtALackedPosition() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const firstAuthor = yield* requireAt(
          harness.engines,
          0,
          "endpoint engine",
        );
        const lagging = yield* requireAt(harness.engines, 1, "endpoint engine");
        const secondAuthor = yield* requireAt(
          harness.engines,
          2,
          "endpoint engine",
        );
        const missed = yield* Effect.fork(
          firstAuthor.send(yield* sendInput(harness, "missed by member 2")),
        );
        yield* missesEveryMessage(harness);
        yield* Fiber.join(missed).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );

        const firstSending = yield* Effect.fork(
          firstAuthor.send(yield* sendInput(harness, "first candidate")),
        );
        const firstBatch = yield* takeReadyBatch(harness);
        const secondSending = yield* Effect.fork(
          secondAuthor.send(yield* sendInput(harness, "second candidate")),
        );
        const secondBatch = yield* takeReadyBatch(harness);
        yield* pump(harness, [...firstBatch, ...secondBatch], [0, 1, 2]);
        yield* Fiber.join(firstSending).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );
        yield* Fiber.join(secondSending).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );

        const pending = yield* lagging.readPendingMessages().pipe(Effect.orDie);
        expect(pending.map(({ message }) => message.content)).toEqual([
          [{ type: "text", text: "open group" }],
          [{ type: "text", text: "missed by member 2" }],
          [{ type: "text", text: "first candidate" }],
          [{ type: "text", text: "second candidate" }],
        ]);
      }),
    ),
  );
}

/**
 * Member 2 misses a post in the N4 conversation, and the members' answers to
 * its catch-up request for the next proposal are delayed. Meanwhile, in a
 * conversation of members 1 to 3, a proposal names a record no member holds:
 * member 2 asks twice, and both members answer that they hold nothing later.
 * The delayed N4 answers then arrive, and with member 4 offline the N4 post
 * certifies with member 2's signature.
 *
 * Value: protects=a catch-up outside recovery keeps taking answers for one
 * conversation after another conversation's catch-up completes;
 * fails_when=completing one conversation's request ends the catch-up while
 * another conversation's request is pending; why_new=other catch-up tests
 * hold a gap in one conversation only; seam=none.
 * @returns Completion once member 2 holds and delivers the N4 posts.
 */
function catchesUpOneConversationAfterAnotherCompletes() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const author = yield* requireAt(harness.engines, 0, "endpoint engine");
        const lagging = yield* requireAt(harness.engines, 1, "endpoint engine");
        const trio = `group:${harness.identities
          .slice(0, 3)
          .map(({ card }) => card.agentName)
          .join(",")}`;
        const opening = yield* Effect.fork(
          author.send(yield* sendInput(harness, "open trio", trio)),
        );
        const genesisBatch = yield* takeReadyBatch(harness);
        const genesis = yield* decodeActionProposal(
          yield* requireAt(genesisBatch, 0, "trio GENESIS proposal"),
        );
        if (genesis.action.kind !== "GENESIS") {
          return yield* Effect.dieMessage("trio send did not propose GENESIS");
        }
        const trioMembership = yield* verifyMembershipDescriptor(
          genesis.action.membership,
          harness.registrySignerPublicKey,
        ).pipe(Effect.orDie);
        yield* pump(harness, genesisBatch, [0, 1, 2]);
        yield* Fiber.join(opening).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );

        const missed = yield* Effect.fork(
          author.send(yield* sendInput(harness, "missed by member 2")),
        );
        yield* missesEveryMessage(harness);
        yield* Fiber.join(missed).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );
        const next = yield* Effect.fork(
          author.send(yield* sendInput(harness, "needs member 2")),
        );
        yield* harness.deliver(yield* takeReadyBatch(harness), [0, 1, 2]);
        yield* harness.drain([0, 1, 2]);
        const delayed = yield* takeQueued(harness);

        const trioPost = yield* Effect.fork(
          author.send(yield* sendInput(harness, "trio post", trio)),
        );
        const forged = yield* forgeUnknownPredecessor(
          harness,
          yield* takeReadyBatch(harness),
          trioMembership,
        );
        yield* harness.deliver([forged], [1]);
        yield* harness.drain([1]);
        yield* pump(harness, yield* takeQueued(harness), [0, 1, 2]);
        yield* pump(harness, delayed, [0, 1, 2]);
        yield* Fiber.join(next).pipe(Effect.timeout("1 second"), Effect.orDie);
        yield* Fiber.interrupt(trioPost);

        const pending = yield* lagging.readPendingMessages().pipe(Effect.orDie);
        expect(pending.map(({ message }) => message.content)).toEqual([
          [{ type: "text", text: "open group" }],
          [{ type: "text", text: "open trio" }],
          [{ type: "text", text: "missed by member 2" }],
          [{ type: "text", text: "needs member 2" }],
        ]);
      }),
    ),
  );
}

function ordersCompetingProposalsBeforeActionVotes(input: {
  readonly firstAuthorIndex: number;
  readonly secondAuthorIndex: number;
}) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const firstAuthor = yield* requireAt(
          harness.engines,
          input.firstAuthorIndex,
          "endpoint engine",
        );
        const secondAuthor = yield* requireAt(
          harness.engines,
          input.secondAuthorIndex,
          "endpoint engine",
        );
        const observingStore = yield* requireAt(
          harness.stores,
          2,
          "endpoint store",
        );

        const firstSending = yield* Effect.fork(
          firstAuthor.send(yield* sendInput(harness, "first candidate")),
        );
        const firstBatch = yield* takeReadyBatch(harness);
        const firstMessage = yield* requireAt(firstBatch, 0, "first proposal");
        const firstProposal = yield* decodeActionProposal(firstMessage);
        const secondSending = yield* Effect.fork(
          secondAuthor.send(yield* sendInput(harness, "second candidate")),
        );
        const secondBatch = yield* takeReadyBatch(harness);
        const secondMessage = yield* requireAt(
          secondBatch,
          0,
          "second proposal",
        );
        const secondProposal = yield* decodeActionProposal(secondMessage);
        if (
          firstProposal.action.kind !== "POST" ||
          secondProposal.action.kind !== "POST"
        ) {
          return yield* Effect.dieMessage(
            "same-predecessor fixture requires two POST proposals",
          );
        }
        expect(firstProposal.action.previousRecordHash).toBe(
          secondProposal.action.previousRecordHash,
        );
        expect(firstProposal).not.toHaveProperty("authorSignature");
        expect(secondProposal).not.toHaveProperty("authorSignature");
        expect(yield* takeQueued(harness)).toEqual([]);

        expect(yield* harness.deliver([firstMessage, secondMessage])).toEqual([
          "accepted",
          "accepted",
          "accepted",
          "accepted",
          "ignored",
          "ignored",
          "ignored",
          "ignored",
        ]);
        yield* harness.drain();
        const emitted = yield* takeQueued(harness);
        const actionSignatures = yield* messagesOfKind(
          emitted,
          "action_signature",
        );
        expect(actionSignatures).toHaveLength(MEMBER_COUNT);
        expect(
          new Set(actionSignatures.map(({ senderAgentId }) => senderAgentId)),
        ).toEqual(new Set(harness.identities.map(({ card }) => card.agentId)));
        const firstActionHash = yield* hashAction(firstProposal.action).pipe(
          Effect.orDie,
        );
        const signatureHashes = yield* Effect.forEach(
          actionSignatures,
          (message) => decodeActionSignatureHash(message),
          { concurrency: 1 },
        );
        expect(new Set(signatureHashes)).toEqual(new Set([firstActionHash]));

        const recovery = yield* observingStore.recover().pipe(Effect.orDie);
        const successorLocks = recovery.proposalLocks.filter(
          ({ previousRecordHash }) =>
            previousRecordHash === firstProposal.action.previousRecordHash,
        );
        expect(successorLocks).toHaveLength(1);
        expect(successorLocks[0]?.actionHash).toBe(firstActionHash);

        yield* Fiber.interrupt(firstSending);
        yield* Fiber.interrupt(secondSending);
      }),
    ),
  );
}

function givesIdenticalHostInvocationsDistinctPostIds() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const author = yield* requireAt(harness.engines, 0, "endpoint engine");
        const input = yield* sendInput(harness, "repeat intentionally");

        const firstSending = yield* Effect.fork(author.send(input));
        const firstBatch = yield* takeReadyBatch(harness);
        const firstProposal = yield* requireAt(
          firstBatch,
          0,
          "first repeated proposal",
        ).pipe(Effect.flatMap(decodeActionProposal));
        yield* pump(harness, firstBatch);
        yield* Fiber.join(firstSending).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );

        const secondSending = yield* Effect.fork(author.send(input));
        const secondBatch = yield* takeReadyBatch(harness);
        const secondProposal = yield* requireAt(
          secondBatch,
          0,
          "second repeated proposal",
        ).pipe(Effect.flatMap(decodeActionProposal));

        expect(secondProposal.action.postIntent.postId).not.toBe(
          firstProposal.action.postIntent.postId,
        );
        yield* pump(harness, secondBatch);
        yield* Fiber.join(secondSending).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );
      }),
    ),
  );
}

function retainsInterruptedDurableSend() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const policyEntered = yield* Deferred.make<undefined>();
        const releasePolicy = yield* Deferred.make<undefined>();
        const harness = yield* makeProtocolHarness({
          actionPolicy: () =>
            Deferred.succeed(policyEntered, undefined).pipe(
              Effect.zipRight(Deferred.await(releasePolicy)),
              Effect.as("sign" as const),
            ),
        });
        const author = yield* requireAt(harness.engines, 0, "endpoint engine");
        const sending = yield* Effect.fork(
          author.send(yield* sendInput(harness, "retained send")),
        );
        yield* Deferred.await(policyEntered);
        const interrupting = yield* Effect.fork(Fiber.interrupt(sending));
        yield* Effect.yieldNow();
        yield* Deferred.succeed(releasePolicy, undefined);
        yield* Fiber.join(interrupting);

        yield* author.drainOutbound.pipe(Effect.orDie);
        const proposal = yield* takeReadyBatch(harness).pipe(
          Effect.flatMap((messages) =>
            requireAt(messages, 0, "retained proposal"),
          ),
          Effect.flatMap(decodeActionProposal),
        );
        expect(proposal.action.postIntent.content).toEqual([
          { type: "text", text: "retained send" },
        ]);
      }),
    ),
  );
}

// @agent-code-guard/regression-only: These stateful traces exercise durable quorum and interruption boundaries across real endpoint engines.
function sendReturnsTheStoredCertifiedRecordHash() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        const recordHash = yield* certifyGenesis(harness);
        const authorStore = yield* requireAt(harness.stores, 0, "store");

        const recovery = yield* authorStore.recover().pipe(Effect.orDie);

        expect(
          recovery.postIntents.map((intent) => intent.completedRecordHash),
        ).toEqual([recordHash]);
      }),
    ),
  );
}

function pendingDeliveryCarriesTheCertifiedRecordHash() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        const recordHash = yield* certifyGenesis(harness);
        const member = yield* requireAt(harness.engines, 1, "endpoint engine");

        const pending = yield* member.readPendingMessages().pipe(Effect.orDie);

        expect(pending.map((message) => message.recordHash)).toEqual([
          recordHash,
        ]);
      }),
    ),
  );
}

describe("fixed-post endpoint protocol", () => {
  it(
    "returns the hash of the send's locally stored certified record",
    sendReturnsTheStoredCertifiedRecordHash,
    TEST_TIMEOUT_MS,
  );
  it(
    "reads a pending delivery with the hash of its certified record",
    pendingDeliveryCarriesTheCertifiedRecordHash,
    TEST_TIMEOUT_MS,
  );
  it(
    "mints a distinct PostId for each identical host invocation",
    givesIdenticalHostInvocationsDistinctPostIds,
    TEST_TIMEOUT_MS,
  );
  it(
    "certifies an author-inclusive N4 POST only after an independent durability quorum",
    certifiesOrdinaryN4Post,
    TEST_TIMEOUT_MS,
  );
  it.each([
    {
      outcome: "fails to restart as persistence",
      binding: "another conversation",
      bind: (membership: VerifiedMembership): DurabilityBinding => ({
        conversationId: unrelatedConversationId,
        membershipHash: membership.hash,
      }),
      filedUnder: 3,
      restart: new EngineInitializationError({ reason: "persistence" }),
    },
    {
      outcome: "fails to restart as persistence",
      binding: "another membership",
      bind: (membership: VerifiedMembership): DurabilityBinding => ({
        conversationId: membership.descriptor.conversationId,
        membershipHash: unrelatedMembershipHash,
      }),
      filedUnder: 3,
      restart: new EngineInitializationError({ reason: "persistence" }),
    },
    {
      outcome: "fails to restart as persistence",
      binding:
        "its own conversation and membership, filed under another member",
      bind: (membership: VerifiedMembership): DurabilityBinding => ({
        conversationId: membership.descriptor.conversationId,
        membershipHash: membership.hash,
      }),
      filedUnder: 2,
      restart: new EngineInitializationError({ reason: "persistence" }),
    },
    {
      outcome: "restarts",
      binding: "its own conversation and membership",
      bind: (membership: VerifiedMembership): DurabilityBinding => ({
        conversationId: membership.descriptor.conversationId,
        membershipHash: membership.hash,
      }),
      filedUnder: 3,
      restart: "started",
    },
  ])(
    "$outcome over a persisted durability vote bound to $binding",
    ({ bind, filedUnder, restart }) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* restartOverPersistedDurabilityVote(
              bind,
              filedUnder,
            );

            expect(restarted).toStrictEqual(restart);
          }),
        ),
      ),
    TEST_TIMEOUT_MS,
  );
  it(
    "creates no action vote before ordering concurrent authors",
    () =>
      ordersCompetingProposalsBeforeActionVotes({
        firstAuthorIndex: 0,
        secondAuthorIndex: 1,
      }),
    TEST_TIMEOUT_MS,
  );
  it(
    "creates no action vote before ordering concurrent sends by one author",
    () =>
      ordersCompetingProposalsBeforeActionVotes({
        firstAuthorIndex: 0,
        secondAuthorIndex: 0,
      }),
    TEST_TIMEOUT_MS,
  );
  it(
    "retains a durably bound send when its caller is interrupted",
    retainsInterruptedDurableSend,
    TEST_TIMEOUT_MS,
  );
  it(
    "sends 1 + 2n outer messages for one N4 post",
    sendsOnePlusTwoNMessagesPerPost,
    TEST_TIMEOUT_MS,
  );
  it.each([
    {
      missed: "every message of a post",
      certifyWithoutMember2: missesEveryMessage,
    },
    {
      missed: "the durability votes of a post",
      certifyWithoutMember2: missesDurabilityVotes,
    },
  ])(
    "catches up a member that missed $missed when the next proposal names it",
    ({ certifyWithoutMember2 }) =>
      laggingMemberCatchesUpAndCertifiesTheNextPost(certifyWithoutMember2),
    TEST_TIMEOUT_MS,
  );
  it(
    "asks again once the members answer a request that predates the named record",
    asksAgainAfterAnswersThatPredateTheNamedRecord,
    TEST_TIMEOUT_MS,
  );
  it(
    "asks for a later gap while a member never answers the earlier request",
    asksForALaterGapWhileAMemberNeverAnswers,
    TEST_TIMEOUT_MS,
  );
  it(
    "asks for no catch-up when a proposal names a record certified before the head",
    ignoresAProposalNamingAPassedRecord,
    TEST_TIMEOUT_MS,
  );
  it(
    "keeps the conversation live after a proposal names a predecessor no member holds",
    unresolvablePredecessorLeavesTheConversationLive,
    TEST_TIMEOUT_MS,
  );
  it(
    "keeps the first Router-ordered proposal at a position a member lacks",
    keepsTheFirstProposalAtALackedPosition,
    TEST_TIMEOUT_MS,
  );
  it(
    "keeps catching up one conversation after another conversation's catch-up completes",
    catchesUpOneConversationAfterAnotherCompletes,
    TEST_TIMEOUT_MS,
  );
});

/* eslint-enable max-lines, max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- Restore repository defaults. */

/**
 * Virtual time short of `ATTACH_BOUND`, so a send still waiting for the
 * worker to attach is pending.
 */
const WITHIN_ATTACH_BOUND = Duration.seconds(30);

/**
 * The send's Router-attachment bound, after which it fails, mirroring the
 * private `send.ts → ROUTER_ATTACH_TIMEOUT`.
 */
const ATTACH_BOUND = Duration.seconds(45);

function sendHeldUntilAttached(): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const attached = yield* Deferred.make<RouterTailAnchor>();
    const harness = yield* makeProtocolHarness({
      attachment: attachesWhenResolved(attached),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "open group")),
    );
    yield* advanceClock(WITHIN_ATTACH_BOUND);
    expect(yield* Fiber.poll(sending)).toEqual(Option.none());
    expect(yield* Queue.size(harness.outbound)).toBe(0);

    yield* Deferred.succeed(attached, { routerInstanceId, pollCursor });
    yield* certifyGenesisOf(harness, sending);
  });
}

function sendFailsAfterAttachBound(): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({ attachment: neverAttaches });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "never attached")),
    );

    yield* advanceClock(ATTACH_BOUND);

    expect(
      yield* Fiber.join(sending).pipe(Effect.flip, Effect.orDie),
    ).toStrictEqual(new SendError({ reason: "network-unavailable" }));
  });
}

/**
 * A worker reaches `active` only after a recovery that abandons the engine's
 * volatile folds under the engine gate. A wait holding that gate would stall
 * the attachment it waits for, so the abandon must complete while the send is
 * still parked.
 */
function attachmentWaitLeavesTheEngineGateFree(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const attached = yield* Deferred.make<RouterTailAnchor>();
    const harness = yield* makeProtocolHarness({
      attachment: attachesWhenResolved(attached),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "open group")),
    );
    yield* advanceClock(WITHIN_ATTACH_BOUND);
    expect(yield* Fiber.poll(sending)).toEqual(Option.none());

    const abandoning = yield* author
      .abandonVolatileFolds("router_restarted")
      .pipe(Effect.timeout("2 seconds"), Effect.fork);
    yield* advanceClock(Duration.seconds(2));
    yield* Fiber.join(abandoning).pipe(Effect.orDie);
    yield* Fiber.interrupt(sending);
  });
}

describe("engine sends and Router-worker attachment", () => {
  it(
    "holds a send issued before the worker attaches and completes it on attachment",
    () => Effect.runPromise(onTestClock(sendHeldUntilAttached())),
    TEST_TIMEOUT_MS,
  );

  it(
    "fails a send as network-unavailable once the attachment bound elapses",
    () => Effect.runPromise(onTestClock(sendFailsAfterAttachBound())),
    TEST_TIMEOUT_MS,
  );

  it(
    "waits for attachment without holding the engine gate recovery needs",
    () =>
      Effect.runPromise(onTestClock(attachmentWaitLeavesTheEngineGateFree())),
    TEST_TIMEOUT_MS,
  );
});

/**
 * Forks `runOutbound` the way a host supervises it: any cause other than
 * interruption completes `fatal`, so a case that expects the loop to
 * survive asserts `fatal` stays empty.
 */
function superviseOutbound(
  engine: EndpointEngine,
  fatal: Deferred.Deferred<never, EngineOutboundError>,
) {
  return engine.runOutbound.pipe(
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.failCause(cause)
        : Deferred.failCause(fatal, cause).pipe(Effect.zipRight(Effect.never)),
    ),
    Effect.interruptible,
    Effect.forkScoped,
  );
}

/** Transmits a transient failure fails before its worker forwards again. */
const FAILED_TRANSMITS = 10;

/**
 * Virtual time for a background drain to work through every failed transmit:
 * the backoff reaches its 5 s cap well before `FAILED_TRANSMITS` attempts.
 */
const OUTAGE_SPAN = Duration.minutes(1);

/**
 * Fails the first `FAILED_TRANSMITS` transmits with `failure`, then forwards.
 * @param failure Worker failure each early transmit reports.
 * @param attempts Counts every transmit.
 * @returns A transmit wrapper for the scripted worker.
 */
function failsThenForwards(
  failure: RouterWorkerSendError,
  attempts: Ref.Ref<number>,
): WrapSend {
  return (forward) => (outboundId) =>
    Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
      Effect.flatMap((count) =>
        count < FAILED_TRANSMITS ? Effect.fail(failure) : forward(outboundId),
      ),
    );
}

/**
 * The distinct action hashes each post was proposed under, across envelopes.
 * @param messages Forwarded action-proposal envelopes.
 * @returns For each PostId, the set of proposed action hashes.
 */
function proposalHashesByPost(
  messages: ReadonlyArray<typeof SignedMessage.Type>,
): Effect.Effect<Map<string, Set<string>>> {
  return Effect.reduce(
    messages,
    new Map<string, Set<string>>(),
    (byPost, message) =>
      decodeActionProposal(message).pipe(
        Effect.flatMap((proposal) =>
          hashAction(proposal.action).pipe(
            Effect.orDie,
            Effect.map((hash) => {
              const postId = proposal.action.postIntent.postId;
              byPost.set(postId, (byPost.get(postId) ?? new Set()).add(hash));
              return byPost;
            }),
          ),
        ),
      ),
  );
}

/**
 * Asserts the background drain outlived every failed transmit, forwarded
 * each envelope once, and proposed the scenario's one post under exactly one
 * action hash.
 * @param harness Harness whose Router queue receives forwarded envelopes.
 * @param attempts Transmit count from `failsThenForwards`.
 * @param fatal The supervised outbound loop's failure signal.
 * @returns Completion after the assertions.
 */
function expectDrainedAlive(
  harness: ProtocolHarness,
  attempts: Ref.Ref<number>,
  fatal: Deferred.Deferred<never, EngineOutboundError>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    expect(yield* Ref.get(attempts)).toBeGreaterThan(FAILED_TRANSMITS);
    const delivered = Array.from(yield* Queue.takeAll(harness.outbound));
    expect(delivered.length).toBeGreaterThan(0);
    expect(new Set(delivered.map(({ messageId }) => messageId)).size).toBe(
      delivered.length,
    );
    const hashesByPost = yield* proposalHashesByPost(delivered);
    expect(Array.from(hashesByPost.values(), (hashes) => hashes.size)).toEqual([
      1,
    ]);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());
  });
}

/**
 * Router restart while a send drains: the worker was attached for the send's
 * probe, then its transmits observe a transient worker state for longer than
 * any bounded retry would allow before the background drain delivers.
 */
function transientTransmitFailureLeavesOutboundLoopAlive(
  failure: RouterWorkerSendError,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const harness = yield* makeProtocolHarness({
      authorSend: failsThenForwards(failure, attempts),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    yield* superviseOutbound(author, fatal);
    const sendResult = yield* author
      .send(yield* sendInput(harness, "router restarts mid-drain"))
      .pipe(Effect.flip, Effect.orDie);
    expect(sendResult).toStrictEqual(
      new SendError({ reason: "network-unavailable" }),
    );
    yield* advanceClock(OUTAGE_SPAN);
    yield* expectDrainedAlive(harness, attempts, fatal);
  });
}

/**
 * Engine cold start with a durable pending outbound row: the restarted
 * worker has not attached yet, as a real worker starts out recovering, while
 * the engine already holds the row for its outbound loop. The loop waits, and
 * once the worker attaches it outlasts every failed transmit and delivers the
 * row.
 * The restarted engine also re-proposes the unfinished post, so the one
 * proposal goes out twice in two envelopes with distinct message ids; peers
 * de-duplicate it by action hash, which the assertions pin as one per post.
 */
function coldStartWithPendingOutboundLeavesOutboundLoopAlive(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({
      authorSend: () => () => Effect.fail(new RouterWorkerUnavailableError()),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    yield* author
      .send(yield* sendInput(harness, "left pending before restart"))
      .pipe(Effect.flip, Effect.orDie);
    const identity = yield* requireAt(harness.identities, 0, "identity");
    const store = yield* requireAt(harness.stores, 0, "endpoint store");
    const attached = yield* Deferred.make<RouterTailAnchor>();
    const attempts = yield* Ref.make(0);
    const restarted = yield* makeEndpointEngine({
      localAgentCard: identity.card,
      signingAuthority: identity.authority,
      registrySignerPublicKey: harness.registrySignerPublicKey,
      registry: harness.registry,
      store,
      actionPolicy: signEveryAction,
      routerWorker: scriptedRouterWorker(
        store,
        harness.outbound,
        attachesWhenResolved(attached),
        failsThenForwards(new RouterWorkerUnavailableError(), attempts),
      ),
    }).pipe(Effect.orDie);
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    yield* superviseOutbound(restarted, fatal);
    yield* advanceClock(OUTAGE_SPAN);
    expect(yield* Ref.get(attempts)).toBe(0);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());

    yield* Deferred.succeed(attached, { routerInstanceId, pollCursor });
    yield* advanceClock(OUTAGE_SPAN);
    yield* expectDrainedAlive(harness, attempts, fatal);
  });
}

/**
 * Starts the first transmit and never finishes it, as a Router that drops
 * packets without a reset after the outbox row has begun; every later
 * transmit forwards.
 * @param transmits Counts every transmit.
 * @param store The author's store, known once the harness exists.
 * @returns A transmit wrapper for the scripted worker.
 */
function blackHolesFirstTransmit(
  transmits: Ref.Ref<number>,
  store: Deferred.Deferred<EndpointStore>,
): WrapSend {
  const beginThenHang = (outboundId: string) =>
    Deferred.await(store).pipe(
      Effect.flatMap((author) => author.beginOutbound(outboundId)),
      Effect.orDie,
      Effect.zipRight(Effect.never),
    );
  const transmitOnce =
    (forward: EngineRouterPort["send"], outboundId: string) =>
    (count: number) =>
      count === 0 ? beginThenHang(outboundId) : forward(outboundId);
  return (forward) => (outboundId) =>
    Ref.getAndUpdate(transmits, (count) => count + 1).pipe(
      Effect.flatMap(transmitOnce(forward, outboundId)),
    );
}

/**
 * The local send's drain bound, after which it answers `network-unavailable`,
 * mirroring the private `index.ts → LOCAL_DRAIN_TIMEOUT`.
 */
const DRAIN_BOUND = Duration.seconds(10);

/**
 * A black-holed transmit holds the local send's drain: the send is still
 * pending one second short of `DRAIN_BOUND` and answers `network-unavailable`
 * one second past it. The background drain then delivers the envelope the
 * interrupted transmit left begun, exactly once however often the queue
 * drains afterwards.
 */
function blackHoledTransmitBoundsTheSend(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const transmits = yield* Ref.make(0);
    const authorStore = yield* Deferred.make<EndpointStore>();
    const harness = yield* makeProtocolHarness({
      authorSend: blackHolesFirstTransmit(transmits, authorStore),
    });
    const store = yield* requireAt(harness.stores, 0, "endpoint store");
    yield* Deferred.succeed(authorStore, store);
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "black-holed transmit")),
    );
    yield* advanceClock(Duration.subtract(DRAIN_BOUND, Duration.seconds(1)));
    expect(yield* Fiber.poll(sending)).toEqual(Option.none());
    yield* advanceClock(Duration.seconds(2));
    expect(
      yield* Fiber.join(sending).pipe(Effect.flip, Effect.orDie),
    ).toStrictEqual(new SendError({ reason: "network-unavailable" }));
    yield* superviseOutbound(author, fatal);
    yield* advanceClock(Duration.seconds(1));
    yield* author.drainOutbound.pipe(Effect.orDie);
    expect(yield* Ref.get(transmits)).toBe(2);
    expect(yield* Queue.size(harness.outbound)).toBe(1);
    expect(
      (yield* store.recover().pipe(Effect.orDie)).outboundMessages,
    ).toEqual([]);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());
  });
}

/** Where a transmit forwards to, known once the harness exists. */
interface ForwardTarget {
  readonly store: EndpointStore;
  readonly outbound: Queue.Queue<typeof SignedMessage.Type>;
}

/**
 * A transmit that spends 100 ms in transit between beginning and completing
 * its outbox row, one transmit at a time as the real worker sends. A transmit
 * that waited for the one before it then finds the row inactive and forwards
 * nothing.
 * @param transmits Counts every transmit.
 * @param target Store and Router queue, once the harness exists.
 * @returns A transmit wrapper for the scripted worker.
 */
function serializedSlowTransmit(
  transmits: Ref.Ref<number>,
  target: Deferred.Deferred<ForwardTarget>,
) {
  const transmitUnder =
    (recoveryGate: Effect.Semaphore) => (outboundId: string) =>
      Ref.update(transmits, (count) => count + 1).pipe(
        Effect.zipRight(Deferred.await(target)),
        Effect.flatMap(({ store, outbound }) =>
          recoveryGate.withPermits(1)(
            forwardStoredOutbound(store, outbound, outboundId, "100 millis"),
          ),
        ),
      );
  return Effect.makeSemaphore(1).pipe(
    Effect.map(
      (recoveryGate): WrapSend =>
        () =>
          transmitUnder(recoveryGate),
    ),
  );
}

/**
 * A local send's drain and the background drain run at once over the same
 * queue head. Both transmit it, and the outbox row still goes out once.
 */
function concurrentDrainsSendEachOutboxOnce(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const transmits = yield* Ref.make(0);
    const target = yield* Deferred.make<ForwardTarget>();
    const harness = yield* makeProtocolHarness({
      authorSend: yield* serializedSlowTransmit(transmits, target),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const store = yield* requireAt(harness.stores, 0, "endpoint store");
    yield* Deferred.succeed(target, { store, outbound: harness.outbound });
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    yield* superviseOutbound(author, fatal);
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "drained twice at once")),
    );
    yield* advanceClock(Duration.seconds(1));
    expect(yield* Ref.get(transmits)).toBe(2);
    expect(yield* Queue.size(harness.outbound)).toBe(1);
    expect(
      (yield* store.recover().pipe(Effect.orDie)).outboundMessages,
    ).toEqual([]);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());
    yield* Fiber.interrupt(sending);
  });
}

const outageAnchor = { routerInstanceId, pollCursor };

function anchorWhile(
  attached: SubscriptionRef.SubscriptionRef<boolean>,
): WorkerAttachment {
  return {
    currentAnchor: SubscriptionRef.get(attached).pipe(
      Effect.flatMap((up) =>
        up
          ? Effect.succeed(outageAnchor)
          : Effect.fail(new RouterWorkerUnavailableError()),
      ),
    ),
    awaitAnchor: attached.changes.pipe(
      Stream.filter((up) => up),
      Stream.runHead,
      Effect.as(outageAnchor),
    ),
  };
}

function transmitWhile(
  attached: SubscriptionRef.SubscriptionRef<boolean>,
  armed: Ref.Ref<boolean>,
  forward: EngineRouterPort["send"],
  outboundId: string,
) {
  return Ref.getAndSet(armed, false).pipe(
    Effect.flatMap((first) =>
      first ? SubscriptionRef.set(attached, false) : Effect.void,
    ),
    Effect.zipRight(SubscriptionRef.get(attached)),
    Effect.flatMap((up) =>
      up
        ? forward(outboundId)
        : Effect.fail(new RouterWorkerUnavailableError()),
    ),
  );
}

/**
 * A worker attached at the send's probe that detaches on its first transmit,
 * as when the poll loop loses the Router mid-send, and reattaches when told.
 */
function detachesOnFirstTransmit(
  attached: SubscriptionRef.SubscriptionRef<boolean>,
) {
  return Ref.make(true).pipe(
    Effect.map(
      (armed): HarnessOptions => ({
        attachment: anchorWhile(attached),
        authorSend: (forward) => (outboundId) =>
          transmitWhile(attached, armed, forward, outboundId),
      }),
    ),
  );
}

/**
 * What a host sees when the Router drops during its send: the send returns
 * `network-unavailable` promptly, the outbound loop stays up, and the durably queued
 * envelope goes out and certifies once the worker re-anchors.
 */
function localSendDuringOutage(): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const attached = yield* SubscriptionRef.make(true);
    const worker = yield* detachesOnFirstTransmit(attached);
    const harness = yield* makeProtocolHarness(worker);
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    yield* superviseOutbound(author, fatal);

    const failure = yield* author
      .send(yield* sendInput(harness, "sent during outage"))
      .pipe(Effect.flip, Effect.orDie);
    expect(failure).toStrictEqual(
      new SendError({ reason: "network-unavailable" }),
    );
    yield* advanceClock(OUTAGE_SPAN);
    expect(yield* Queue.size(harness.outbound)).toBe(0);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());

    yield* SubscriptionRef.set(attached, true);
    yield* advanceClock(Duration.seconds(10));
    yield* pump(harness, yield* takeReadyBatch(harness));
    const recoveries = yield* Effect.forEach(
      harness.stores,
      (store) => store.recover().pipe(Effect.orDie),
      { concurrency: 1 },
    );
    expect(
      recoveries.map(({ certifiedRecords }) => certifiedRecords.length),
    ).toEqual([1, 1, 1, 1]);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());
  });
}

/**
 * A scoped scenario on the TestClock, so backoff and timeouts pass in virtual
 * time.
 * @param scenario Scoped scenario to run.
 * @returns The scenario with its scope closed and test services provided.
 */
function onTestClock(
  scenario: Effect.Effect<void, never, Scope.Scope>,
): Effect.Effect<void> {
  return Effect.scoped(scenario).pipe(Effect.provide(TestContext.TestContext));
}

describe("a local send during a Router outage", () => {
  it(
    "returns network-unavailable at once and delivers the post after re-attachment",
    () => Effect.runPromise(onTestClock(localSendDuringOutage())),
    TEST_TIMEOUT_MS,
  );
  it(
    "sends each outbox row once while the local and background drains race",
    () => Effect.runPromise(onTestClock(concurrentDrainsSendEachOutboxOnce())),
    TEST_TIMEOUT_MS,
  );
  it(
    "bounds a black-holed transmit and delivers its envelope exactly once",
    () => Effect.runPromise(onTestClock(blackHoledTransmitBoundsTheSend())),
    TEST_TIMEOUT_MS,
  );
});

describe("outbound loop under a transient Router worker state", () => {
  it(
    "keeps the outbound loop alive when the worker reports unavailable mid-drain",
    () =>
      Effect.runPromise(
        onTestClock(
          transientTransmitFailureLeavesOutboundLoopAlive(
            new RouterWorkerUnavailableError(),
          ),
        ),
      ),
    TEST_TIMEOUT_MS,
  );
  it(
    "keeps the outbound loop alive when a transmit observes a Router restart",
    () =>
      Effect.runPromise(
        onTestClock(
          transientTransmitFailureLeavesOutboundLoopAlive(
            new RouterWorkerDiscontinuityError(),
          ),
        ),
      ),
    TEST_TIMEOUT_MS,
  );
  it(
    "keeps the outbound loop alive when the Router transport drops mid-drain",
    () =>
      Effect.runPromise(
        onTestClock(
          transientTransmitFailureLeavesOutboundLoopAlive(
            new RouterWorkerTransportError(),
          ),
        ),
      ),
    TEST_TIMEOUT_MS,
  );
  it(
    "keeps a cold-started outbound loop alive with a pending outbound row",
    () =>
      Effect.runPromise(
        onTestClock(coldStartWithPendingOutboundLeavesOutboundLoopAlive()),
      ),
    TEST_TIMEOUT_MS,
  );
});
