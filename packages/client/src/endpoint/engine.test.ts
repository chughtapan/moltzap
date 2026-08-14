/** @file Two-endpoint START, retry identity, staging, and durability tests. */

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
  type SignedMessage,
  SignedMessage as SignedMessageSchema,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { PollCursor, RouterInstanceId } from "@moltzap/router";
import canonicalize from "canonicalize";
import { Deferred, Effect, Encoding, Fiber, Redacted, Schema } from "effect";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RouterWorkerIngress } from "./router-worker.js";
import { ConversationId, type StartInput } from "../contract.js";
import { recoverEngineState } from "./engine-recovery.js";
import {
  type EndpointEngine,
  type EndpointEngineInput,
  EngineStartError,
  makeEndpointEngine,
} from "./engine.js";
import {
  type ActionCertificate,
  ActionCertifiedRecord,
  BeginDigest,
  CertifiedRecord,
  decodeCanonical,
  decodeOuterBody,
  encodeCanonical,
  fingerprintReply,
  hashActionCertificate,
  hashActionCertifiedRecord,
  makeActionBinding,
  type MulticastAction,
  type RecordHash,
  signEvidenceMessage,
  type VerifiedMembership,
  verifyCertifiedRecord,
} from "./representation.js";
import { type EndpointStore, openEndpointStore } from "./store.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function -- The scripted two-endpoint trace keeps its ordering assertions next to the network steps. */

interface Harness {
  readonly engines: readonly [EndpointEngine, EndpointEngine];
  readonly stores: readonly [EndpointStore, EndpointStore];
  readonly inputs: readonly [EndpointEngineInput, EndpointEngineInput];
  readonly sent: SignedMessage[];
  readonly persistenceEvents: readonly string[];
  readonly awaitFirstOutbound: Effect.Effect<void>;
  readonly deliverAll: () => Effect.Effect<void>;
}

interface StagedMulticast {
  readonly action: MulticastAction;
  readonly record: typeof ActionCertifiedRecord.Type;
  readonly recordHash: RecordHash;
  readonly votes: readonly SignedMessage[];
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const conversationId = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000001",
);

const routerInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
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

const makeHarness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const registryKeys = generateKeyPairSync("ed25519");
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const firstAuthority = yield* makeAuthority();
  const secondAuthority = yield* makeAuthority();
  const firstCard = yield* issueCard({
    byte: 1,
    name: "engine-first",
    authority: firstAuthority,
    registryPrivateKey: registryKeys.privateKey,
    registrySignerPublicKey,
  });
  const secondCard = yield* issueCard({
    byte: 2,
    name: "engine-second",
    authority: secondAuthority,
    registryPrivateKey: registryKeys.privateKey,
    registrySignerPublicKey,
  });
  const cards = [firstCard, secondCard] as const;
  const authorities = [firstAuthority, secondAuthority] as const;
  const firstStore = yield* openEndpointStore(
    yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-engine-a-",
    }),
  );
  const secondStore = yield* openEndpointStore(
    yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-engine-b-",
    }),
  );
  const stores = [firstStore, secondStore] as const;
  const sent: SignedMessage[] = [];
  const persistenceEvents: string[] = [];
  const firstOutbound = yield* Deferred.make<undefined>();
  const observeStore = (
    store: EndpointStore,
    index: number,
  ): EndpointStore => ({
    ...store,
    stageRecord: (record) =>
      Effect.sync(() => {
        persistenceEvents.push(`stage:${index}`);
      }).pipe(Effect.zipRight(store.stageRecord(record))),
    mergeEvidence: (evidence) =>
      Effect.sync(() => {
        if (evidence.kind === "durability") {
          persistenceEvents.push(`vote:${index}`);
        }
      }).pipe(Effect.zipRight(store.mergeEvidence(evidence))),
  });
  const observedStores = [
    observeStore(firstStore, 0),
    observeStore(secondStore, 1),
  ] as const;
  const makeInput = (index: 0 | 1) => ({
    localAgentCard: cards[index],
    signingAuthority: authorities[index],
    registrySignerPublicKey,
    registry: {
      lookup: (
        request: Readonly<
          | { agentName: typeof AgentName.Type }
          | { agentId: typeof AgentId.Type }
        >,
      ): Effect.Effect<RegistryLookupResult> => {
        const found = cards.find((card) =>
          "agentName" in request
            ? card.agentName === request.agentName
            : card.agentId === request.agentId,
        );
        return Effect.succeed(
          found === undefined
            ? { kind: "not_found" as const }
            : { kind: "found" as const, agentCard: found },
        );
      },
    },
    store: observedStores[index],
    routerWorker: {
      currentAnchor: Effect.succeed({ routerInstanceId, pollCursor }),
      send: (message: SignedMessage) =>
        Effect.sync(() => {
          sent.push(message);
        }).pipe(
          Effect.zipRight(Deferred.succeed(firstOutbound, undefined)),
          Effect.asVoid,
        ),
    },
  });
  const inputs = [makeInput(0), makeInput(1)] as const;
  const first = yield* makeEndpointEngine(inputs[0]);
  const second = yield* makeEndpointEngine(inputs[1]);
  const engines = [first, second] as const;
  const deliverAll = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (sent.length > 0) {
        const batch = sent.splice(0);
        for (const message of batch) {
          const senderCard = cards.find(
            (card) => card.agentId === message.senderAgentId,
          );
          if (senderCard === undefined) {
            return yield* Effect.die("unknown sender");
          }
          const payload = yield* decodeOuterBody(message.body).pipe(
            Effect.orDie,
          );
          const verifiedMessage = yield* SignedMessageSchema.verify({
            signedMessage: message,
            agentCard: senderCard,
          }).pipe(Effect.orDie);
          const ingress: RouterWorkerIngress<typeof payload> = {
            message: verifiedMessage,
            senderCard,
            payload,
          };
          yield* first.acceptRouterIngress(ingress).pipe(Effect.orDie);
          yield* second.acceptRouterIngress(ingress).pipe(Effect.orDie);
        }
        yield* first.drainOutbound.pipe(Effect.orDie);
        yield* second.drainOutbound.pipe(Effect.orDie);
      }
    });
  return {
    engines,
    inputs,
    stores,
    sent,
    persistenceEvents,
    awaitFirstOutbound: Deferred.await(firstOutbound),
    deliverAll,
  } satisfies Harness;
}).pipe(Effect.provide(NodeFileSystem.layer));

const startInput = (text: string): StartInput => ({
  conversationId,
  peers: [Schema.decodeUnknownSync(AgentName)("engine-second")],
  content: [{ type: "text", text }],
});

const beginDigest = Schema.decodeUnknownSync(BeginDigest)(
  `bgn_${Encoding.encodeBase64Url(new Uint8Array(32).fill(7))}`,
);

const signActionEvidence = (
  input: EndpointEngineInput,
  action: MulticastAction,
) =>
  makeActionBinding(action).pipe(
    Effect.flatMap((binding) =>
      signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "action_signature",
          signerAgentId: input.localAgentCard.agentId,
          action: binding,
        },
        agentCard: input.localAgentCard,
        signingAuthority: input.signingAuthority,
      }),
    ),
  );

const signDurabilityEvidence = (
  input: EndpointEngineInput,
  membershipHash: MulticastAction["membershipHash"],
  recordHash: RecordHash,
) =>
  signEvidenceMessage({
    statement: {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "durability_vote",
      signerAgentId: input.localAgentCard.agentId,
      conversationId,
      membershipHash,
      recordHash,
    },
    agentCard: input.localAgentCard,
    signingAuthority: input.signingAuthority,
  });

const requireElement = <Element>(
  values: readonly Element[],
  index: number,
  message: string,
): Effect.Effect<Element> =>
  Effect.gen(function* () {
    const value = values[index];
    if (value === undefined) {
      return yield* Effect.die(message);
    }
    return value;
  });

const establishStart = (harness: Harness) =>
  Effect.gen(function* () {
    const startFiber = yield* Effect.fork(
      harness.engines[0].start(startInput("foundation")),
    );
    yield* harness.awaitFirstOutbound;
    yield* harness.deliverAll();
    yield* Fiber.join(startFiber);

    const startRecovery = yield* harness.stores[0].recover();
    const storedStart = yield* requireElement(
      startRecovery.certifiedRecords,
      0,
      "missing START record",
    );
    const certifiedStart = yield* decodeCanonical(
      CertifiedRecord,
      storedStart.canonicalCertifiedRecord,
    ).pipe(Effect.orDie);
    const membership = yield* verifyCertifiedRecord({
      record: certifiedStart,
      registrySignerPublicKey: harness.inputs[0].registrySignerPublicKey,
    }).pipe(Effect.orDie);
    return { certifiedStart, membership };
  });

const stageMulticast = (
  harness: Harness,
  certifiedStart: typeof CertifiedRecord.Type,
  membership: VerifiedMembership,
) =>
  Effect.gen(function* () {
    const content = [{ type: "text" as const, text: "reply" }] as const;
    const action: MulticastAction = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "multicast_action",
      conversationId,
      membershipHash: membership.hash,
      anchorHash: certifiedStart.actionCertifiedRecord.anchorHash,
      previousRecordHash: certifiedStart.recordHash,
      beginDigest,
      actionId: "MULTICAST",
      authorAgentId: harness.inputs[0].localAgentCard.agentId,
      content,
      replyFingerprint: yield* fingerprintReply(content).pipe(Effect.orDie),
    };
    const actionEvidence = yield* Effect.forEach(
      harness.inputs,
      (input) => signActionEvidence(input, action).pipe(Effect.orDie),
      { concurrency: 1 },
    );
    const encodedSignatures = yield* Effect.forEach(
      actionEvidence,
      (message) => Schema.encode(SignedMessageSchema)(message),
      { concurrency: 1 },
    );
    const firstSignature = yield* requireElement(
      encodedSignatures,
      0,
      "missing action signature",
    );
    const certificate: ActionCertificate = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certificate",
      action: yield* makeActionBinding(action).pipe(Effect.orDie),
      signatures: [firstSignature, ...encodedSignatures.slice(1)],
    };
    const record: typeof ActionCertifiedRecord.Type = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certified_record" as const,
      membership: membership.membership,
      anchorHash: action.anchorHash,
      action,
      actionHash: yield* hashActionCertificate(certificate).pipe(Effect.orDie),
      actionCertificate: certificate,
    };
    const recordHash = yield* hashActionCertifiedRecord(record).pipe(
      Effect.orDie,
    );
    yield* harness.stores[0].stageRecord({
      conversationId,
      recordHash,
      previousRecordHash: certifiedStart.recordHash,
      membershipHash: membership.hash,
      anchorHash: action.anchorHash,
      canonicalRecord: yield* encodeCanonical(
        ActionCertifiedRecord,
        record,
      ).pipe(Effect.orDie),
    });
    yield* Effect.forEach(
      actionEvidence,
      (message) =>
        encodeCanonical(SignedMessageSchema, message).pipe(
          Effect.orDie,
          Effect.flatMap((canonicalEvidence) =>
            harness.stores[0].mergeEvidence({
              conversationId,
              kind: "action",
              subjectId: beginDigest,
              evidenceKey: message.senderAgentId,
              canonicalEvidence,
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    const votes = yield* Effect.forEach(
      harness.inputs,
      (input) =>
        signDurabilityEvidence(input, membership.hash, recordHash).pipe(
          Effect.orDie,
        ),
      { concurrency: 1 },
    );
    const firstVote = yield* requireElement(
      votes,
      0,
      "missing durability vote",
    );
    yield* encodeCanonical(SignedMessageSchema, firstVote).pipe(
      Effect.orDie,
      Effect.flatMap((canonicalEvidence) =>
        harness.stores[0].mergeEvidence({
          conversationId,
          kind: "durability",
          subjectId: recordHash,
          evidenceKey: firstVote.senderAgentId,
          canonicalEvidence,
        }),
      ),
    );
    return { action, record, recordHash, votes } satisfies StagedMulticast;
  });

const inspectStagedMulticast = (
  harness: Harness,
  certifiedStart: typeof CertifiedRecord.Type,
) =>
  Effect.gen(function* () {
    const staged = yield* recoverEngineState(
      harness.inputs[0],
      yield* harness.stores[0].recover(),
    ).pipe(Effect.orDie);
    const recoveredFold = staged.multicastFolds.get(beginDigest);
    expect(recoveredFold?.actionSignatures.size).toBe(2);
    expect(recoveredFold?.durabilityVotes.size).toBe(1);
    expect(staged.conversations.get(conversationId)?.head?.recordHash).toBe(
      certifiedStart.recordHash,
    );
  });

const promoteMulticast = (
  harness: Harness,
  certifiedStart: typeof CertifiedRecord.Type,
  staged: StagedMulticast,
) =>
  Effect.gen(function* () {
    const secondVote = yield* requireElement(
      staged.votes,
      1,
      "missing second durability vote",
    );
    yield* encodeCanonical(SignedMessageSchema, secondVote).pipe(
      Effect.orDie,
      Effect.flatMap((canonicalEvidence) =>
        harness.stores[0].mergeEvidence({
          conversationId,
          kind: "durability",
          subjectId: staged.recordHash,
          evidenceKey: secondVote.senderAgentId,
          canonicalEvidence,
        }),
      ),
    );
    const encodedVotes = yield* Effect.forEach(
      staged.votes,
      (message) => Schema.encode(SignedMessageSchema)(message),
      { concurrency: 1 },
    );
    const firstEncodedVote = yield* requireElement(
      encodedVotes,
      0,
      "missing encoded durability vote",
    );
    const certified: typeof CertifiedRecord.Type = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "certified_record" as const,
      recordHash: staged.recordHash,
      actionCertifiedRecord: staged.record,
      routerAnchor: certifiedStart.routerAnchor,
      durabilityVotes: [firstEncodedVote, ...encodedVotes.slice(1)],
    };
    yield* harness.stores[0].promoteRecord({
      conversationId,
      recordHash: staged.recordHash,
      previousRecordHash: certifiedStart.recordHash,
      membershipHash: staged.action.membershipHash,
      anchorHash: staged.action.anchorHash,
      canonicalRecord: yield* encodeCanonical(
        ActionCertifiedRecord,
        staged.record,
      ).pipe(Effect.orDie),
      canonicalCertifiedRecord: yield* encodeCanonical(
        CertifiedRecord,
        certified,
      ).pipe(Effect.orDie),
    });
    return yield* recoverEngineState(
      harness.inputs[0],
      yield* harness.stores[0].recover(),
    ).pipe(Effect.orDie);
  });

const reconstructsStagedMulticastAndLatestHead = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const { certifiedStart, membership } = yield* establishStart(harness);
        const staged = yield* stageMulticast(
          harness,
          certifiedStart,
          membership,
        );
        yield* inspectStagedMulticast(harness, certifiedStart);
        const completed = yield* promoteMulticast(
          harness,
          certifiedStart,
          staged,
        );
        expect(completed.conversations.get(conversationId)?.head).toMatchObject(
          {
            recordHash: staged.recordHash,
            action: {
              kind: "multicast_action",
              content: staged.action.content,
            },
          },
        );
      }),
    ),
  );

const certifiesStartAcrossTwoEndpoints = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const startFiber = yield* Effect.fork(
          harness.engines[0].start(startInput("hello")),
        );
        yield* harness.awaitFirstOutbound;
        const initialRecovery = yield* harness.stores[0].recover();
        expect(initialRecovery.startIntents).toHaveLength(1);
        expect(initialRecovery.stagedRecords).toHaveLength(0);
        expect(harness.sent).toHaveLength(1);

        yield* harness.deliverAll();
        const result = yield* Fiber.join(startFiber);
        expect(result).toBeUndefined();
        const firstRecovery = yield* harness.stores[0].recover();
        const secondRecovery = yield* harness.stores[1].recover();
        expect(firstRecovery.certifiedRecords).toHaveLength(1);
        expect(secondRecovery.certifiedRecords).toHaveLength(1);
        expect(firstRecovery.stagedRecords).toHaveLength(1);
        expect(
          firstRecovery.evidence.filter(({ kind }) => kind === "durability"),
        ).toHaveLength(2);
        for (const index of [0, 1]) {
          expect(
            harness.persistenceEvents.indexOf(`stage:${index}`),
          ).toBeLessThan(harness.persistenceEvents.indexOf(`vote:${index}`));
        }

        yield* harness.engines[0]
          .start(startInput("hello"))
          .pipe(Effect.timeout("1 second"));
        const changed = yield* Effect.flip(
          harness.engines[0].start(startInput("changed")),
        );
        expect(changed).toBeInstanceOf(EngineStartError);
        expect(changed.reason).toBe("intent-conflict");
      }),
    ),
  );

describe("endpoint START engine", () => {
  it(
    "resumes one canonical intent and completes only after local promotion",
    certifiesStartAcrossTwoEndpoints,
  );
  it(
    "reconstructs a staged MULTICAST fold and the durable latest head",
    reconstructsStagedMulticastAndLatestHead,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function -- Restore repository defaults. */
