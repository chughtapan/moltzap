/** @file Real N4 fixed-post certification through four durable endpoint engines. */

import type { RegistryLookupResult } from "@moltzap/identity/registry";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
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
  Duration,
  Effect,
  Either,
  Encoding,
  Fiber,
  Option,
  Queue,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  EndpointEngineInput,
  EngineActionFold,
  EngineRegistryPort,
  EngineRouterPort,
} from "../engine-types.js";
import {
  type HistoryExportRecord,
  SendError,
  SendInput,
} from "../../contract.js";
import { type EndpointEngine, makeEndpointEngine } from "../engine.js";
import { recoverFoldEvidence } from "../recovery/store-evidence.js";
import {
  type ActionCertifiedRecord as ActionCertifiedRecordValue,
  type ActionProposal,
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
} from "../representation.js";
import {
  type RouterIngressDisposition,
  type RouterTailAnchor,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
  RouterWorkerUnavailableError,
} from "../router-worker/index.js";
import { type EndpointStore, openEndpointStore } from "../store.js";

/* eslint-disable max-lines, max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- The full protocol traces share one four-endpoint harness and keep controlled Router phases beside durable assertions. */

interface ProtocolIdentity {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthorityValue;
}

interface ProtocolHarness {
  readonly identities: readonly ProtocolIdentity[];
  readonly engines: readonly EndpointEngine[];
  readonly stores: readonly EndpointStore[];
  /** Every history-export record each engine wrote, by engine index. */
  readonly exported: readonly HistoryExportRecord[][];
  readonly membership: VerifiedMembership;
  readonly outbound: Queue.Queue<typeof SignedMessage.Type>;
  readonly groupAddress: string;
  readonly deliver: (
    messages: ReadonlyArray<typeof SignedMessage.Type>,
    endpointIndexes?: readonly number[],
  ) => Effect.Effect<readonly RouterIngressDisposition[]>;
  readonly drain: (endpointIndexes?: readonly number[]) => Effect.Effect<void>;
}

const MEMBER_COUNT = 4;
const TEST_TIMEOUT_MS = 30_000;

function identifier(prefix: string, byte: number): string {
  return `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;
}

function hashIdentifier(prefix: string, byte: number): string {
  return `${prefix}${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`;
}

const routerInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 31),
);
const pollCursor = Schema.decodeUnknownSync(PollCursor)(
  `plc_eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwidHlwIjoiYXBwbGljYXRpb24vdm5kLm1vbHR6YXAucG9sbC1jdXJzb3IrandlIn0..${Encoding.encodeBase64Url(new Uint8Array(12).fill(32))}.${Encoding.encodeBase64Url(new Uint8Array(120).fill(33))}.${Encoding.encodeBase64Url(new Uint8Array(16).fill(34))}`,
);
const unrelatedConversationId = Schema.decodeUnknownSync(ConversationId)(
  hashIdentifier("cnv_", 35),
);
const unrelatedMembershipHash = Schema.decodeUnknownSync(MembershipHash)(
  hashIdentifier("mbr_", 36),
);
const endpointIndexes = Object.freeze([0, 1, 2, 3]);

function makeAuthority() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
}

function issueCard(input: {
  readonly byte: number;
  readonly authority: AgentSigningAuthorityValue;
  readonly registryPrivateKey: KeyObject;
  readonly registrySignerPublicKey: typeof Ed25519PublicKey.Type;
}): Effect.Effect<VerifiedAgentCard> {
  return Effect.gen(function* () {
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
      agentName: Schema.decodeUnknownSync(AgentName)(
        `protocol-member-${input.byte}`,
      ),
      issuedAt: `2026-08-27T12:00:${String(input.byte).padStart(2, "0")}Z`,
      kind: "agentCard",
      moltzapVersion: MOLTZAP_VERSION,
      principalId: Schema.decodeUnknownSync(PrincipalId)(
        identifier("prn_", input.byte),
      ),
      publicKey: AgentSigningAuthority.publicKey(input.authority),
    });
    if (protectedText === undefined || payloadText === undefined) {
      return yield* Effect.dieMessage("canonical AgentCard fixture failed");
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
}

function makeIdentities(
  registryPrivateKey: KeyObject,
  registrySignerPublicKey: typeof Ed25519PublicKey.Type,
) {
  return Effect.forEach(
    endpointIndexes,
    (index) =>
      Effect.gen(function* () {
        const authority = yield* makeAuthority();
        return {
          card: yield* issueCard({
            byte: index + 1,
            authority,
            registryPrivateKey,
            registrySignerPublicKey,
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
  request: Parameters<EngineRegistryPort["lookup"]>[0],
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

function forwardStoredOutbound(
  store: EndpointStore,
  outbound: Queue.Queue<typeof SignedMessage.Type>,
  outboundId: string,
): Effect.Effect<void> {
  return store.beginOutbound(outboundId).pipe(
    Effect.flatMap((attempt) => {
      switch (attempt.kind) {
        case "inactive":
          return Effect.void;
        case "pending":
          return decodeCanonical(
            SignedMessage,
            attempt.outbound.canonicalSignedMessage,
          ).pipe(
            Effect.flatMap((message) =>
              store
                .completeOutbound(attempt.outbound)
                .pipe(Effect.zipRight(Queue.offer(outbound, message))),
            ),
            Effect.asVoid,
          );
        default: {
          const exhaustive: never = attempt;
          return exhaustive;
        }
      }
    }),
    Effect.orDie,
  );
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
): EngineRouterPort {
  const anchor = { routerInstanceId, pollCursor };
  return {
    currentAnchor: attachment?.currentAnchor ?? Effect.succeed(anchor),
    awaitAnchor: attachment?.awaitAnchor ?? Effect.succeed(anchor),
    send: (outboundId: string) =>
      forwardStoredOutbound(store, outbound, outboundId),
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
  readonly attachTimeout?: Duration.Duration;
}

function recordingExport(
  exported: readonly HistoryExportRecord[][],
  index: number,
): NonNullable<EndpointEngineInput["historyExport"]> {
  return {
    record: (record) =>
      Effect.sync(() => {
        exported[index]?.push(record);
      }),
  };
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
    const identities = yield* makeIdentities(
      registryKeys.privateKey,
      registrySignerPublicKey,
    );
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
    const registry: EngineRegistryPort = {
      lookup: (request) => Effect.succeed(lookupIdentity(identities, request)),
    };
    const exported = identities.map((): HistoryExportRecord[] => []);
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
              ),
              ...(options.attachTimeout === undefined
                ? {}
                : { routerAttachTimeout: options.attachTimeout }),
              historyExport: recordingExport(exported, index),
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
      exported,
      membership,
      outbound,
      groupAddress: `group:${identities.map(({ card }) => card.agentName).join(",")}`,
      deliver,
      drain,
    } satisfies ProtocolHarness;
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie);
}

function sendInput(harness: ProtocolHarness, text: string) {
  return Schema.decodeUnknown(SendInput)({
    to: harness.groupAddress,
    content: [{ type: "text", text }],
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

function pump(
  harness: ProtocolHarness,
  initial: ReadonlyArray<typeof SignedMessage.Type>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    let batch = initial;
    for (let round = 0; round < 32; round += 1) {
      if (batch.length === 0) {
        return;
      }
      yield* harness.deliver(batch);
      yield* harness.drain();
      batch = yield* takeQueued(harness);
    }
    return yield* Effect.dieMessage("scripted Router did not become idle");
  });
}

function certifyGenesisOf(
  harness: ProtocolHarness,
  sending: Fiber.RuntimeFiber<void, SendError>,
): Effect.Effect<void> {
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
    yield* Fiber.join(sending).pipe(Effect.timeout("1 second"), Effect.orDie);
  });
}

function certifyGenesis(harness: ProtocolHarness): Effect.Effect<void> {
  return Effect.gen(function* () {
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "open group")),
    );
    yield* certifyGenesisOf(harness, sending);
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

function rejectsPersistedDurabilityBinding(
  mutatedBinding: "conversation" | "membership",
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const author = yield* requireAt(harness.identities, 0, "identity");
        const hostileSigner = yield* requireAt(
          harness.identities,
          3,
          "hostile signer",
        );
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
          authorEngine.send(yield* sendInput(harness, "stage successor")),
        );
        const proposalBatch = yield* takeReadyBatch(harness);
        yield* harness.deliver(proposalBatch);
        yield* harness.drain();
        const actionSignatures = yield* messagesOfKind(
          yield* takeQueued(harness),
          "action_signature",
        );
        expect(actionSignatures).toHaveLength(MEMBER_COUNT);
        yield* harness.deliver(actionSignatures.slice(0, 3));
        yield* harness.drain();
        const actionRecordMessages = yield* messagesOfKind(
          yield* takeQueued(harness),
          "action_certified_record",
        );
        const authorActionRecordMessage = actionRecordMessages.find(
          (message) => message.senderAgentId === author.card.agentId,
        );
        if (authorActionRecordMessage === undefined) {
          return yield* Effect.dieMessage(
            "author did not assemble the staged action certificate",
          );
        }
        const actionRecord = yield* decodeActionCertifiedRecord(
          authorActionRecordMessage,
        );
        const invalidEvidence = yield* signEvidenceMessage({
          statement: {
            moltzapVersion: MOLTZAP_VERSION,
            kind: "durability_vote",
            signerAgentId: hostileSigner.card.agentId,
            conversationId:
              mutatedBinding === "conversation"
                ? unrelatedConversationId
                : harness.membership.descriptor.conversationId,
            membershipHash:
              mutatedBinding === "membership"
                ? unrelatedMembershipHash
                : harness.membership.hash,
            recordHash: actionRecord.recordHash,
          },
          agentCard: hostileSigner.card,
          signingAuthority: hostileSigner.authority,
        });
        yield* authorStore
          .mergeEvidence({
            conversationId: harness.membership.descriptor.conversationId,
            kind: "durability",
            subjectId: actionRecord.recordHash,
            evidenceKey: hostileSigner.card.agentId,
            canonicalEvidence: yield* encodeCanonical(
              SignedMessage,
              invalidEvidence,
            ),
          })
          .pipe(Effect.orDie);
        yield* Fiber.interrupt(sending);

        const fold: EngineActionFold = {
          conversation: {
            conversationId: harness.membership.descriptor.conversationId,
            membership: harness.membership,
            currentAnchor: actionRecord.routerAnchor,
          },
          action: actionRecord.recordCore.action,
          actionHash: actionRecord.recordCore.actionHash,
          routerAnchor: actionRecord.routerAnchor,
          actionEvidence: new Map(),
          durabilityEvidence: new Map(),
          localActionEvidenceQueued: true,
          actionCertifiedRecordQueued: true,
          localDurabilityEvidenceQueued: true,
          certifiedRecordQueued: false,
          recordHash: actionRecord.recordHash,
        };
        const recovered = yield* recoverFoldEvidence(
          yield* authorStore.recover().pipe(Effect.orDie),
          new Map([[fold.actionHash, fold]]),
          new Map([[actionRecord.recordHash, fold]]),
        ).pipe(Effect.either);

        yield* Either.match(recovered, {
          onLeft: (failure) =>
            Effect.sync(() => {
              expect(failure).toBeInstanceOf(RouterWorkerPersistenceError);
            }),
          onRight: () =>
            Effect.dieMessage(
              `recovery accepted a durability vote with a mutated ${mutatedBinding} binding`,
            ),
        });
      }),
    ),
  );
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

        let recovery = yield* authorStore.recover().pipe(Effect.orDie);
        expect(
          recovery.stagedRecords.some(
            ({ recordHash }) => recordHash === actionRecord.recordHash,
          ),
        ).toBe(true);
        expect(
          recovery.certifiedRecords.some(
            ({ recordHash }) => recordHash === actionRecord.recordHash,
          ),
        ).toBe(false);
        expect(
          recovery.evidence.filter(
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

        recovery = yield* authorStore.recover().pipe(Effect.orDie);
        expect(
          recovery.certifiedRecords.some(
            ({ recordHash }) => recordHash === actionRecord.recordHash,
          ),
        ).toBe(false);
        expect(
          recovery.evidence.filter(
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
        recovery = yield* authorStore.recover().pipe(Effect.orDie);
        expect(
          recovery.certifiedRecords.some(
            ({ recordHash }) => recordHash === actionRecord.recordHash,
          ),
        ).toBe(false);

        expect(yield* harness.deliver([secondRemoteVote], [0])).toEqual([
          "accepted",
        ]);
        yield* Fiber.join(sending).pipe(Effect.orDie);
        recovery = yield* authorStore.recover().pipe(Effect.orDie);
        const storedPost = recovery.certifiedRecords.find(
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
function exportsCertifiedSendAndDeliveries() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeProtocolHarness();
        yield* certifyGenesis(harness);
        const author = yield* requireAt(harness.identities, 0, "identity");

        const authorExports = yield* requireAt(harness.exported, 0, "records");
        expect(authorExports).toHaveLength(1);
        const [sent] = authorExports;
        if (sent?.kind !== "outbound" || sent.outcome.kind !== "certified") {
          return yield* Effect.dieMessage(
            "the author did not export one certified send",
          );
        }
        expect(sent.to).toBe(harness.groupAddress);
        expect(sent.content).toEqual([{ type: "text", text: "open group" }]);

        for (const index of [1, 2, 3]) {
          const received = yield* requireAt(harness.exported, index, "records");
          expect(received).toHaveLength(1);
          const [delivered] = received;
          if (delivered?.kind !== "inbound") {
            return yield* Effect.dieMessage(
              `endpoint ${String(index)} did not export one inbound delivery`,
            );
          }
          expect(delivered.message.address).toBe(harness.groupAddress);
          expect(delivered.message.postId).toBe(sent.outcome.postId);
          expect(delivered.message.sender).toBe(
            `agent:${author.card.agentName}`,
          );
          expect(delivered.message.content).toEqual(sent.content);
        }
      }),
    ),
  );
}

describe("fixed-post endpoint protocol", () => {
  it(
    "exports the author's certified send and every member's delivery",
    exportsCertifiedSendAndDeliveries,
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
  it(
    "rejects a persisted durability vote bound to another conversation",
    () => rejectsPersistedDurabilityBinding("conversation"),
    TEST_TIMEOUT_MS,
  );
  it(
    "rejects a persisted durability vote bound to another membership",
    () => rejectsPersistedDurabilityBinding("membership"),
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
});

/* eslint-enable max-lines, max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- Restore repository defaults. */

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
    yield* Effect.sleep("50 millis");
    expect(yield* Fiber.poll(sending)).toEqual(Option.none());
    expect(yield* Queue.size(harness.outbound)).toBe(0);

    yield* Deferred.succeed(attached, { routerInstanceId, pollCursor });
    yield* certifyGenesisOf(harness, sending);
  });
}

function sendFailsAfterAttachBound(): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({
      attachment: neverAttaches,
      attachTimeout: Duration.millis(50),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const failure = yield* author
      .send(yield* sendInput(harness, "never attached"))
      .pipe(Effect.flip, Effect.orDie);
    expect(failure).toStrictEqual(
      new SendError({ reason: "network-unavailable" }),
    );
    expect(failure.message).toContain(failure.reason);
  });
}

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
    yield* Effect.sleep("50 millis");
    expect(yield* Fiber.poll(sending)).toEqual(Option.none());

    // A worker reaches `active` only after a recovery that abandons the
    // engine's volatile folds under the engine gate. A wait holding that gate
    // would stall the attachment it waits for, so this must complete while
    // the send above is still parked.
    yield* author
      .abandonVolatileFolds("router_restarted")
      .pipe(Effect.timeout("2 seconds"), Effect.orDie);
    yield* Fiber.interrupt(sending);
  });
}

describe("engine sends and Router-worker attachment", () => {
  it(
    "holds a send issued before the worker attaches and completes it on attachment",
    () => Effect.runPromise(Effect.scoped(sendHeldUntilAttached())),
    TEST_TIMEOUT_MS,
  );

  it(
    "fails a send as network-unavailable once the attachment bound elapses",
    () => Effect.runPromise(Effect.scoped(sendFailsAfterAttachBound())),
    TEST_TIMEOUT_MS,
  );

  it(
    "waits for attachment without holding the engine gate recovery needs",
    () =>
      Effect.runPromise(Effect.scoped(attachmentWaitLeavesTheEngineGateFree())),
    TEST_TIMEOUT_MS,
  );
});
