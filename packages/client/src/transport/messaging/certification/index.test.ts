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
  type ActionCertifiedRecord as ActionCertifiedRecordValue,
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
  type RecordHash,
  signEvidenceMessage,
  signOuterEvidence,
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
): Effect.Effect<EngineSendInput> {
  return Effect.all({
    to: Schema.decodeUnknown(MessageAddressInput)(harness.groupAddress),
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

function decodeActionCertifiedRecord(
  message: typeof SignedMessage.Type,
): Effect.Effect<ActionCertifiedRecordValue> {
  return decodeOuterBody(message.body).pipe(
    Effect.flatMap((body) =>
      body.kind === "direct" && body.packet.kind === "action_certified_record"
        ? Effect.succeed(body.packet)
        : Effect.dieMessage("expected action-certified record"),
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
 * Deliver a batch to every engine, drain each, and repeat with whatever the
 * engines queued, until a round queues nothing. An exchange still producing
 * traffic after 32 rounds is a defect in the scripted Router, so it dies.
 * @param harness Engines and the scripted Router queue they send through.
 * @param initial First batch to deliver.
 * @returns Every delivered message in delivery order, once the exchange is
 *   idle.
 */
function pump(
  harness: ProtocolHarness,
  initial: ReadonlyArray<typeof SignedMessage.Type>,
): Effect.Effect<ReadonlyArray<typeof SignedMessage.Type>> {
  return Effect.gen(function* () {
    const delivered: Array<typeof SignedMessage.Type> = [];
    let batch = initial;
    for (let round = 0; round < 32; round += 1) {
      if (batch.length === 0) {
        return delivered;
      }
      yield* harness.deliver(batch);
      delivered.push(...batch);
      yield* harness.drain();
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
    const authorActionRecordMessage = (yield* messagesOfKind(
      yield* takeQueued(harness),
      "action_certified_record",
    )).find((message) => message.senderAgentId === author.card.agentId);
    if (authorActionRecordMessage === undefined) {
      return yield* Effect.dieMessage(
        "author did not assemble the staged action certificate",
      );
    }
    const actionRecord = yield* decodeActionCertifiedRecord(
      authorActionRecordMessage,
    );
    const vote = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "durability_vote",
        signerAgentId: voter.card.agentId,
        ...bind(harness.membership),
        recordHash: actionRecord.recordHash,
      },
      agentCard: voter.card,
      signingAuthority: voter.authority,
    }).pipe(Effect.orDie);
    yield* authorStore
      .mergeEvidence({
        conversationId: harness.membership.descriptor.conversationId,
        kind: "durability",
        subjectId: actionRecord.recordHash,
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
        const actionRecordMessages = yield* messagesOfKind(
          certificationBatch,
          "action_certified_record",
        );
        const durabilityMessages = yield* messagesOfKind(
          certificationBatch,
          "durability_vote",
        );
        expect(actionRecordMessages).toHaveLength(MEMBER_COUNT);
        expect(durabilityMessages).toHaveLength(MEMBER_COUNT);

        const authorActionRecordMessage = actionRecordMessages.find(
          (message) => message.senderAgentId === author.card.agentId,
        );
        if (authorActionRecordMessage === undefined) {
          return yield* Effect.dieMessage(
            "author did not assemble the POST action certificate",
          );
        }
        const actionRecord = yield* decodeActionCertifiedRecord(
          authorActionRecordMessage,
        );
        expect(actionRecord.recordCore.action.kind).toBe(proposal.action.kind);
        expect(actionRecord.actionCertificate.signatures).toHaveLength(3);
        const actionSigners = yield* Effect.forEach(
          actionRecord.actionCertificate.signatures,
          (representation) =>
            Schema.decodeUnknown(SignedMessage)(representation),
          { concurrency: 1 },
        ).pipe(Effect.orDie);
        expect(
          actionSigners.some(
            (signature) => signature.senderAgentId === author.card.agentId,
          ),
        ).toBe(true);

        const staged = yield* authorStore.recover().pipe(Effect.orDie);
        expect(
          staged.stagedRecords.some(
            ({ recordHash }) => recordHash === actionRecord.recordHash,
          ),
        ).toBe(true);
        expect(
          staged.certifiedRecords.some(
            ({ recordHash }) => recordHash === actionRecord.recordHash,
          ),
        ).toBe(false);
        expect(
          staged.evidence.filter(
            ({ kind, subjectId }) =>
              kind === "durability" && subjectId === actionRecord.recordHash,
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
          recordHash: actionRecord.recordHash,
          conversationId: unrelatedConversationId,
          membershipHash: harness.membership.hash,
        });
        const wrongMembershipVote = yield* hostileDurabilityMessage({
          harness,
          signer: hostileSigner,
          recordHash: actionRecord.recordHash,
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
            ({ recordHash }) => recordHash === actionRecord.recordHash,
          ),
        ).toBe(false);
        expect(
          afterHostileVotes.evidence.filter(
            ({ kind, subjectId }) =>
              kind === "durability" && subjectId === actionRecord.recordHash,
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
            ({ recordHash }) => recordHash === actionRecord.recordHash,
          ),
        ).toBe(false);

        expect(yield* harness.deliver([secondRemoteVote], [0])).toEqual([
          "accepted",
        ]);
        yield* Fiber.join(sending).pipe(Effect.orDie);
        const certified = yield* authorStore.recover().pipe(Effect.orDie);
        const storedPost = certified.certifiedRecords.find(
          ({ recordHash }) => recordHash === actionRecord.recordHash,
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
        expect(storedCore.action.kind).toBe(
          actionRecord.recordCore.action.kind,
        );
        expect(storedCore.actionHash).toBe(actionRecord.recordCore.actionHash);
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

/**
 * A sender whose retry finds its first copy evicted resends the same outer
 * message under the same MessageId, and Router appends it again. Here every
 * member receives the proposal a second time mid-exchange and the whole
 * exchange a second time after certification, and still holds one post.
 */
function reappendedOuterMessagesYieldOnePost() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        const genesisHash = yield* certifyGenesis(harness);
        const author = yield* requireAt(harness.engines, 0, "endpoint engine");
        const sending = yield* Effect.fork(
          author.send(yield* sendInput(harness, "appended twice")),
        );
        const proposalBatch = yield* takeReadyBatch(harness);
        yield* harness.deliver(proposalBatch);
        yield* harness.drain();
        const transcript = yield* pump(harness, [
          ...proposalBatch,
          ...(yield* takeQueued(harness)),
        ]);
        const sent = yield* Fiber.join(sending).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );

        yield* pump(harness, transcript);

        const recoveries = yield* Effect.forEach(
          harness.stores,
          (store) => store.recover().pipe(Effect.orDie),
          { concurrency: 1 },
        );
        expect(
          recoveries.map(({ certifiedRecords }) => certifiedRecords.length),
        ).toEqual([2, 2, 2, 2]);
        const pendingHashes = yield* Effect.forEach(
          harness.engines.slice(1),
          (engine) =>
            engine.readPendingMessages().pipe(
              Effect.orDie,
              Effect.map((pending) =>
                pending.map((message) => message.recordHash),
              ),
            ),
          { concurrency: 1 },
        );
        expect(pendingHashes).toEqual([
          [genesisHash, sent.recordHash],
          [genesisHash, sent.recordHash],
          [genesisHash, sent.recordHash],
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
    "holds one post when Router appends its outer messages twice",
    reappendedOuterMessagesYieldOnePost,
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
