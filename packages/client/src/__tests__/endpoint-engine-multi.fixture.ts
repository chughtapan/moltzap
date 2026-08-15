/** @file Scripted in-memory Router delivery for private multi-endpoint engine tests. */

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
  Effect,
  Encoding,
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
import type { RouterWorkerIngress } from "../endpoint/router-worker.js";
import { ConversationId, type StartInput } from "../contract.js";
import {
  type EndpointEngine,
  type EndpointEngineInput,
  makeEndpointEngine,
} from "../endpoint/engine.js";
import {
  decodeCanonical,
  decodeOuterBody,
  EvidenceStatement,
} from "../endpoint/representation.js";
import { type EndpointStore, openEndpointStore } from "../endpoint/store.js";

interface ScriptedIdentity {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthorityValue;
}

/** Deterministic endpoints and Router controls shared by multi-member tests. */
export interface ScriptedEngineHarness {
  readonly conversationId: typeof ConversationId.Type;
  readonly identities: readonly ScriptedIdentity[];
  readonly engines: readonly EndpointEngine[];
  readonly stores: readonly EndpointStore[];
  readonly inputs: readonly EndpointEngineInput[];
  readonly waitForOutbound: Effect.Effect<void>;
  readonly startInput: (authorIndex: number, text: string) => StartInput;
  readonly takeOutbound: () => SignedMessage[];
  readonly drain: (endpointIndexes?: readonly number[]) => Effect.Effect<void>;
  readonly deliver: (
    messages: readonly SignedMessage[],
    options?: Readonly<{
      endpointIndexes?: readonly number[];
      copies?: number;
    }>,
  ) => Effect.Effect<void>;
  readonly pump: (
    options?: Readonly<{
      endpointIndexes?: readonly number[];
      copies?: number;
    }>,
  ) => Effect.Effect<void>;
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const routerInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 29),
);

const pollCursor = Schema.decodeUnknownSync(PollCursor)(
  `plc_eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwidHlwIjoiYXBwbGljYXRpb24vdm5kLm1vbHR6YXAucG9sbC1jdXJzb3IrandlIn0..${Encoding.encodeBase64Url(new Uint8Array(12).fill(21))}.${Encoding.encodeBase64Url(new Uint8Array(120).fill(22))}.${Encoding.encodeBase64Url(new Uint8Array(16).fill(23))}`,
);

const allIndexes = (length: number): readonly number[] => {
  const indexes: number[] = [];
  for (let index = 0; index < length; index += 1) {
    indexes.push(index);
  }
  return indexes;
};

const at = <Value>(values: readonly Value[], index: number): Value => {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`missing scripted endpoint ${index}`);
  }
  return value;
};

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
      agentName: Schema.decodeUnknownSync(AgentName)(
        `scripted-engine-${input.byte}`,
      ),
      issuedAt: `2026-08-13T12:00:${String(input.byte).padStart(2, "0")}Z`,
      kind: "agentCard",
      moltzapVersion: MOLTZAP_VERSION,
      principalId: Schema.decodeUnknownSync(PrincipalId)(
        identifier("prn_", input.byte),
      ),
      publicKey: AgentSigningAuthority.publicKey(input.authority),
    });
    if (protectedText === undefined || payloadText === undefined) {
      return yield* Effect.die("canonical card fixture failed");
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

/**
 * Decode the inner protocol kind without inspecting engine state.
 * @param message Signed Router message emitted by the scripted endpoint.
 * @returns An effect that yields the decoded protocol kind.
 */
export const scriptedMessageKind = (
  message: SignedMessage,
): Effect.Effect<string> =>
  decodeOuterBody(message.body).pipe(
    Effect.flatMap((payload) =>
      payload.kind === "direct"
        ? Effect.succeed(payload.packet.kind)
        : decodeCanonical(EvidenceStatement, payload.message.body).pipe(
            Effect.map((statement) => statement.kind),
          ),
    ),
    Effect.orDie,
  );

type IdentityLookupRequest = Readonly<
  { agentName: typeof AgentName.Type } | { agentId: typeof AgentId.Type }
>;

interface EngineInputFixture {
  readonly identities: readonly ScriptedIdentity[];
  readonly stores: readonly EndpointStore[];
  readonly registrySignerPublicKey: typeof Ed25519PublicKey.Type;
  readonly outbound: SignedMessage[];
  readonly outboundReady: Deferred.Deferred<undefined>;
}

const makeIdentities = (
  memberCount: number,
  registryPrivateKey: KeyObject,
  registrySignerPublicKey: typeof Ed25519PublicKey.Type,
) =>
  Effect.forEach(
    allIndexes(memberCount),
    (index) =>
      Effect.gen(function* () {
        const authority = yield* makeAuthority();
        const card = yield* issueCard({
          byte: index + 1,
          authority,
          registryPrivateKey,
          registrySignerPublicKey,
        });
        return { card, authority } satisfies ScriptedIdentity;
      }),
    { concurrency: 1 },
  );

const makeStores = (memberCount: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* Effect.forEach(
      allIndexes(memberCount),
      (index) =>
        fileSystem
          .makeTempDirectoryScoped({
            prefix: `moltzap-engine-${memberCount}-${index}-`,
          })
          .pipe(Effect.flatMap(openEndpointStore)),
      { concurrency: 1 },
    );
  });

const lookupIdentity = (
  identities: readonly ScriptedIdentity[],
  request: IdentityLookupRequest,
): RegistryLookupResult => {
  const found = identities.find(({ card }) =>
    "agentName" in request
      ? card.agentName === request.agentName
      : card.agentId === request.agentId,
  );
  return found === undefined
    ? { kind: "not_found" }
    : { kind: "found", agentCard: found.card };
};

const makeEngineInputs = (
  fixture: EngineInputFixture,
): readonly EndpointEngineInput[] =>
  fixture.identities.map(
    (identity, index): EndpointEngineInput => ({
      localAgentCard: identity.card,
      signingAuthority: identity.authority,
      registrySignerPublicKey: fixture.registrySignerPublicKey,
      registry: {
        lookup: (request) =>
          Effect.succeed(lookupIdentity(fixture.identities, request)),
      },
      store: at(fixture.stores, index),
      routerWorker: {
        currentAnchor: Effect.succeed({ routerInstanceId, pollCursor }),
        send: (message) =>
          Effect.sync(() => {
            fixture.outbound.push(message);
          }).pipe(
            Effect.zipRight(Deferred.succeed(fixture.outboundReady, undefined)),
            Effect.asVoid,
          ),
      },
    }),
  );

const makeDrain =
  (
    engines: readonly EndpointEngine[],
    indexes: readonly number[],
  ): ScriptedEngineHarness["drain"] =>
  (endpointIndexes = indexes) =>
    Effect.forEach(
      endpointIndexes,
      (index) => at(engines, index).drainOutbound,
      { concurrency: 1, discard: true },
    ).pipe(Effect.orDie);

const decodeIngress = (
  identities: readonly ScriptedIdentity[],
  message: SignedMessage,
) =>
  Effect.gen(function* () {
    const sender = identities.find(
      ({ card }) => card.agentId === message.senderAgentId,
    );
    if (sender === undefined) {
      return yield* Effect.die("unknown scripted sender");
    }
    const payload = yield* decodeOuterBody(message.body).pipe(Effect.orDie);
    const verifiedMessage = yield* SignedMessage.verify({
      signedMessage: message,
      agentCard: sender.card,
    }).pipe(Effect.orDie);
    const ingress: RouterWorkerIngress<typeof payload> = {
      message: verifiedMessage,
      senderCard: sender.card,
      payload,
    };
    return ingress;
  });

const deliverMessage = (
  identities: readonly ScriptedIdentity[],
  engines: readonly EndpointEngine[],
  endpointIndexes: readonly number[],
  message: SignedMessage,
): Effect.Effect<void> =>
  decodeIngress(identities, message).pipe(
    Effect.flatMap((ingress) =>
      Effect.forEach(
        endpointIndexes,
        (index) =>
          at(engines, index).acceptRouterIngress(ingress).pipe(Effect.orDie),
        { concurrency: 1, discard: true },
      ),
    ),
  );

const makeDeliver =
  (
    identities: readonly ScriptedIdentity[],
    engines: readonly EndpointEngine[],
    indexes: readonly number[],
  ): ScriptedEngineHarness["deliver"] =>
  (messages, options = {}) =>
    Effect.forEach(
      allIndexes(options.copies ?? 1),
      () =>
        Effect.forEach(
          messages,
          (message) =>
            deliverMessage(
              identities,
              engines,
              options.endpointIndexes ?? indexes,
              message,
            ),
          { concurrency: 1, discard: true },
        ),
      { concurrency: 1, discard: true },
    );

const makePump =
  (
    takeOutbound: () => SignedMessage[],
    deliver: ScriptedEngineHarness["deliver"],
    drain: ScriptedEngineHarness["drain"],
    indexes: readonly number[],
  ): ScriptedEngineHarness["pump"] =>
  (options = {}) =>
    Effect.gen(function* () {
      for (let round = 0; round < 32; round += 1) {
        const batch = takeOutbound();
        if (batch.length === 0) {
          return;
        }
        yield* deliver(batch, options);
        yield* drain(options.endpointIndexes ?? indexes);
      }
      return yield* Effect.die("scripted Router did not become idle");
    });

const makeStartInput =
  (
    identities: readonly ScriptedIdentity[],
    conversationId: typeof ConversationId.Type,
  ): ScriptedEngineHarness["startInput"] =>
  (authorIndex, text) => {
    const author = at(identities, authorIndex);
    const peers = identities
      .filter((identity) => identity !== author)
      .map(({ card }) => card.agentName);
    const first = peers[0];
    if (first === undefined) {
      throw new Error("scripted START requires a peer");
    }
    return {
      conversationId,
      peers: [first, ...peers.slice(1)],
      content: [{ type: "text", text }],
    };
  };

const makeHarness = (memberCount: number) =>
  Effect.gen(function* () {
    if (memberCount < 2 || memberCount > 32) {
      return yield* Effect.die(
        "scripted membership must contain 2..32 endpoints",
      );
    }
    const registryKeys = generateKeyPairSync("ed25519");
    const registrySignerPublicKey = yield* Schema.decodeUnknown(
      Ed25519PublicKey,
    )(registryKeys.publicKey.export({ format: "jwk" }));
    const identities = yield* makeIdentities(
      memberCount,
      registryKeys.privateKey,
      registrySignerPublicKey,
    );
    const stores = yield* makeStores(memberCount);
    const outbound: SignedMessage[] = [];
    const outboundReady = yield* Deferred.make<undefined>();
    const inputs = makeEngineInputs({
      identities,
      stores,
      registrySignerPublicKey,
      outbound,
      outboundReady,
    });
    const engines = yield* Effect.forEach(inputs, makeEndpointEngine, {
      concurrency: 1,
    });
    const indexes = allIndexes(memberCount);
    const drain = makeDrain(engines, indexes);
    const deliver = makeDeliver(identities, engines, indexes);
    const takeOutbound = (): SignedMessage[] => outbound.splice(0);
    const conversationId = Schema.decodeUnknownSync(ConversationId)(
      `00000000-0000-4000-8000-${String(memberCount).padStart(12, "0")}`,
    );
    return {
      conversationId,
      identities,
      engines,
      stores,
      inputs,
      waitForOutbound: Deferred.await(outboundReady),
      startInput: makeStartInput(identities, conversationId),
      takeOutbound,
      drain,
      deliver,
      pump: makePump(takeOutbound, deliver, drain, indexes),
    } satisfies ScriptedEngineHarness;
  });

/**
 * Acquire deterministic identities, stores, and engines behind one scripted Router.
 * @param memberCount Number of endpoints in the scripted membership.
 * @returns A scoped effect that acquires the complete scripted harness.
 */
export const makeScriptedEngineHarness = (
  memberCount: number,
): Effect.Effect<ScriptedEngineHarness, never, Scope.Scope> =>
  makeHarness(memberCount).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.orDie,
    Effect.withSpan("makeScriptedEngineHarness"),
  );
