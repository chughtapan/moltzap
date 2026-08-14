/** @file Scripted in-memory Router delivery for private multi-endpoint engine tests. */

import type { RegistryLookupResult } from "@moltzap/identity/registry";
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
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { PollCursor, RouterInstanceId } from "@moltzap/router";
import canonicalize from "canonicalize";
import { Deferred, Effect, Encoding, Redacted, Schema } from "effect";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signBytes,
} from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const allIndexes = (length: number): readonly number[] =>
  Array.from({ length }, (_, index) => index);

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
 * @param message
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

/**
 * Acquire deterministic identities, stores, and engines behind one scripted Router.
 * @param memberCount
 */
export const makeScriptedEngineHarness = (
  memberCount: number,
): Effect.Effect<ScriptedEngineHarness, never, import("effect").Scope.Scope> =>
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
    const identities = yield* Effect.forEach(
      allIndexes(memberCount),
      (index) =>
        Effect.gen(function* () {
          const authority = yield* makeAuthority();
          const card = yield* issueCard({
            byte: index + 1,
            authority,
            registryPrivateKey: registryKeys.privateKey,
            registrySignerPublicKey,
          });
          return { card, authority } satisfies ScriptedIdentity;
        }),
      { concurrency: 1 },
    );
    const stores = yield* Effect.forEach(
      allIndexes(memberCount),
      (index) =>
        openEndpointStore(
          mkdtempSync(
            join(tmpdir(), `moltzap-engine-${memberCount}-${index}-`),
          ),
        ),
      { concurrency: 1 },
    );
    const outbound: SignedMessage[] = [];
    const outboundReady = yield* Deferred.make<void>();
    const inputs = identities.map(
      (identity, index): EndpointEngineInput => ({
        localAgentCard: identity.card,
        signingAuthority: identity.authority,
        registrySignerPublicKey,
        registry: {
          lookup: (
            request: Readonly<
              | { agentName: typeof AgentName.Type }
              | { agentId: typeof AgentId.Type }
            >,
          ): Effect.Effect<RegistryLookupResult> => {
            const found = identities.find(({ card }) =>
              "agentName" in request
                ? card.agentName === request.agentName
                : card.agentId === request.agentId,
            );
            return Effect.succeed(
              found === undefined
                ? { kind: "not_found" as const }
                : { kind: "found" as const, agentCard: found.card },
            );
          },
        },
        store: at(stores, index),
        routerWorker: {
          currentAnchor: Effect.succeed({ routerInstanceId, pollCursor }),
          send: (message) =>
            Effect.sync(() => {
              outbound.push(message);
            }).pipe(
              Effect.zipRight(Deferred.succeed(outboundReady, undefined)),
              Effect.asVoid,
            ),
        },
      }),
    );
    const engines = yield* Effect.forEach(inputs, makeEndpointEngine, {
      concurrency: 1,
    });
    const indexes = allIndexes(memberCount);
    const drain = (endpointIndexes = indexes): Effect.Effect<void> =>
      Effect.forEach(
        endpointIndexes,
        (index) => at(engines, index).drainOutbound,
        { concurrency: 1, discard: true },
      ).pipe(Effect.orDie);
    const deliver: ScriptedEngineHarness["deliver"] = (
      messages,
      options = {},
    ) =>
      Effect.forEach(
        Array.from({ length: options.copies ?? 1 }),
        () =>
          Effect.forEach(
            messages,
            (message) =>
              Effect.gen(function* () {
                const sender = identities.find(
                  ({ card }) => card.agentId === message.senderAgentId,
                );
                if (sender === undefined) {
                  return yield* Effect.die("unknown scripted sender");
                }
                const payload = yield* decodeOuterBody(message.body).pipe(
                  Effect.orDie,
                );
                const ingress = {
                  message,
                  senderCard: sender.card,
                  payload,
                } as RouterWorkerIngress<typeof payload>;
                yield* Effect.forEach(
                  options.endpointIndexes ?? indexes,
                  (index) =>
                    at(engines, index)
                      .acceptRouterIngress(ingress)
                      .pipe(Effect.orDie),
                  { concurrency: 1, discard: true },
                );
              }),
            { concurrency: 1, discard: true },
          ),
        { concurrency: 1, discard: true },
      );
    const takeOutbound = (): SignedMessage[] => outbound.splice(0);
    const pump: ScriptedEngineHarness["pump"] = (options = {}) =>
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
    const conversationId = Schema.decodeUnknownSync(ConversationId)(
      `00000000-0000-4000-8000-${String(memberCount).padStart(12, "0")}`,
    );
    const startInput = (authorIndex: number, text: string): StartInput => {
      const peers = identities
        .filter((_, index) => index !== authorIndex)
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
    return {
      conversationId,
      identities,
      engines,
      stores,
      inputs,
      waitForOutbound: Deferred.await(outboundReady),
      startInput,
      takeOutbound,
      drain,
      deliver,
      pump,
    };
  }).pipe(Effect.orDie);
