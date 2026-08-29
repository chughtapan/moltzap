/** @file Deterministic Identity and Router fixtures for Router worker tests. */

import {
  AgentCard,
  AgentId,
  type AgentId as AgentIdValue,
  AgentName,
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  Ed25519PublicKey,
  MessageId,
  MOLTZAP_VERSION,
  PrincipalId,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import {
  Registry,
  type RegistryLookupResult,
} from "@moltzap/identity/registry";
import {
  PollCursor,
  Router,
  RouterInstanceId,
  type RouterPollResult,
  type RouterSendRequest,
  type RouterSendResult,
} from "@moltzap/router";
import canonicalize from "canonicalize";
import {
  type Context,
  Effect,
  Encoding,
  Layer,
  Redacted,
  Ref,
  Schema,
} from "effect";
import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import type { RouterWorkerInput } from "./index.js";

/** Payload decoded by the scripted worker callback. */
export interface TestPayload {
  readonly text: string;
}

interface PollCall {
  readonly hasCursor: boolean;
}

interface SendCall {
  readonly request: RouterSendRequest;
}

interface ScriptedRouter {
  readonly polls: Ref.Ref<RouterPollResult[]>;
  readonly sends: Ref.Ref<RouterSendResult[]>;
  readonly pollCalls: Ref.Ref<PollCall[]>;
  readonly sendCalls: Ref.Ref<SendCall[]>;
  readonly fallbackPoll?: Effect.Effect<RouterPollResult>;
}

interface CanonicalCardTextsInput {
  readonly byte: number;
  readonly name: string;
  readonly localAuthority: AgentSigningAuthorityValue;
  readonly registryThumbprint: string;
}

interface SignMessageInput {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthorityValue;
  readonly recipient: AgentIdValue;
  readonly id: number;
  readonly body: string;
}

interface ScriptedRouterInput {
  readonly polls: readonly RouterPollResult[];
  readonly sends?: readonly RouterSendResult[];
  readonly fallbackPoll?: Effect.Effect<RouterPollResult>;
}

/** Identity material used by one Router worker test endpoint. */
export interface Fixture {
  readonly localCard: VerifiedAgentCard;
  readonly localAuthority: AgentSigningAuthorityValue;
}

/** Fails any unexpected store-backed outbound operation. */
export const unreachableOutbox: RouterWorkerInput<TestPayload>["outbox"] =
  Object.freeze({
    enqueueOutbound: () => Effect.die("outbox must not be used"),
    beginOutbound: () => Effect.die("outbox must not be used"),
    replaceOutbound: () => Effect.die("outbox must not be used"),
    completeOutbound: () => Effect.die("outbox must not be used"),
  });

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const agentId = (byte: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(identifier("agt_", byte));

/**
 * Construct a deterministic test MessageId.
 * @param byte Repeated identifier byte.
 * @returns Decoded MessageId.
 */
export const messageId = (byte: number) =>
  Schema.decodeUnknownSync(MessageId)(identifier("msg_", byte));

/**
 * Construct a deterministic test RouterInstanceId.
 * @param byte Repeated identifier byte.
 * @returns Decoded RouterInstanceId.
 */
export const routerInstanceId = (byte: number) =>
  Schema.decodeUnknownSync(RouterInstanceId)(identifier("rti_", byte));

/**
 * Construct a deterministic authenticated test cursor.
 * @param byte Repeated cursor byte.
 * @returns Decoded PollCursor.
 */
export const pollCursor = (byte: number) =>
  Schema.decodeUnknownSync(PollCursor)(
    `plc_eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwidHlwIjoiYXBwbGljYXRpb24vdm5kLm1vbHR6YXAucG9sbC1jdXJzb3IrandlIn0..${Encoding.encodeBase64Url(new Uint8Array(12).fill(byte))}.${Encoding.encodeBase64Url(new Uint8Array(120).fill(byte))}.${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`,
  );

/**
 * Build verified agent material with deterministic protocol identifiers.
 * @param byte Repeated AgentId and PrincipalId byte.
 * @param name Canonical agent name.
 * @returns Verified card and its signing authority.
 */
export const makeIdentityFixture = (byte: number, name: string) =>
  Effect.gen(function* () {
    const localKeys = generateKeyPairSync("ed25519");
    const registryKeys = generateKeyPairSync("ed25519");
    const localPrivateKey = localKeys.privateKey.export({
      format: "pem",
      type: "pkcs8",
    });
    const localAuthority = yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(localPrivateKey),
    ).pipe(Effect.orDie);
    const registrySignerPublicKey = yield* Schema.decodeUnknown(
      Ed25519PublicKey,
    )(registryKeys.publicKey.export({ format: "jwk" }));
    const registryThumbprint = createHash("sha256")
      .update(canonicalize(registrySignerPublicKey) ?? "")
      .digest("base64url");
    const { payloadText, protectedText } = yield* canonicalCardTexts({
      byte,
      name,
      localAuthority,
      registryThumbprint,
    });
    const protectedValue = Buffer.from(protectedText).toString("base64url");
    const payload = Buffer.from(payloadText).toString("base64url");
    const signature = signBytes(
      null,
      Buffer.from(`${protectedValue}.${payload}`),
      registryKeys.privateKey,
    ).toString("base64url");
    const parsedLocal = yield* Schema.decodeUnknown(AgentCard)({
      payload,
      signatures: [{ protected: protectedValue, signature }],
    });
    const localCard = yield* AgentCard.verify({
      agentCard: parsedLocal,
      registrySignerPublicKey,
    });
    return {
      localCard,
      localAuthority,
    } satisfies Fixture;
  }).pipe(Effect.withSpan("makeIdentityFixture"));

/** Default local identity fixture shared by Router worker scenarios. */
export const makeFixture = makeIdentityFixture(1, "worker-local");

/**
 * Sign one deterministic Router worker test envelope.
 * @param input Identity, recipient, identifier byte, and body.
 * @returns Signed test envelope.
 */
export const signMessage = (
  input: SignMessageInput,
): Effect.Effect<SignedMessageValue> =>
  SignedMessage.sign({
    agentCard: input.card,
    signingAuthority: input.authority,
    recipientAgentIds: new Set([input.recipient]),
    messageId: messageId(input.id),
    body: new TextEncoder().encode(input.body),
  }).pipe(Effect.orDie, Effect.withSpan("signMessage"));

/**
 * Build a Router layer that consumes explicit poll and send results in order.
 * @param input Ordered poll and send results plus an optional poll fallback.
 * @returns Mutable script evidence and its Router layer.
 */
export const makeScriptedRouter = (input: ScriptedRouterInput) =>
  Effect.gen(function* () {
    const scripted: ScriptedRouter = {
      polls: yield* Ref.make([...input.polls]),
      sends: yield* Ref.make([...(input.sends ?? [])]),
      pollCalls: yield* Ref.make<PollCall[]>([]),
      sendCalls: yield* Ref.make<SendCall[]>([]),
      fallbackPoll: input.fallbackPoll,
    };
    return {
      scripted,
      layer: Layer.succeed(Router, scriptedRouterService(scripted)),
    };
  }).pipe(Effect.withSpan("makeScriptedRouter"));

/**
 * Resolve only the verified cards named by a test.
 * @param cards Cards available to Registry lookup.
 * @returns Registry test layer.
 */
export const registryLayer = (cards: readonly VerifiedAgentCard[]) =>
  Layer.succeed(Registry, {
    lookup: (request): Effect.Effect<RegistryLookupResult> => {
      const found = cards.find((card) =>
        "agentId" in request
          ? card.agentId === request.agentId
          : card.agentName === request.agentName,
      );
      return Effect.succeed(
        found === undefined
          ? { kind: "not_found" as const }
          : { kind: "found" as const, agentCard: found },
      );
    },
    list: () =>
      Effect.succeed({ kind: "page", agentCards: cards, hasMore: false }),
    register: () => Effect.succeed({ kind: "idempotency_conflict" }),
  });

/** Registry layer that proves pinned cards make live lookup unnecessary. */
export const unavailableRegistryLayer = Layer.succeed(Registry, {
  lookup: () => Effect.die("Registry must not be queried for a pinned sender"),
  list: () => Effect.die("Registry unavailable"),
  register: () => Effect.die("Registry unavailable"),
});

/**
 * Build an empty Router poll batch at a deterministic cursor.
 * @param instance Router instance for the batch.
 * @param cursor Cursor committed by the batch.
 * @returns Empty poll result.
 */
export const emptyBatch = (
  instance: ReturnType<typeof routerInstanceId>,
  cursor: ReturnType<typeof pollCursor>,
): RouterPollResult => ({
  kind: "batch",
  routerInstanceId: instance,
  signedMessages: [],
  pollCursor: cursor,
});

/**
 * Build a Router poll batch carrying the supplied envelopes.
 * @param instance Router instance for the batch.
 * @param cursor Cursor committed by the batch.
 * @param signedMessages Ordered envelopes in the batch.
 * @returns Populated poll result.
 */
export const batch = (
  instance: ReturnType<typeof routerInstanceId>,
  cursor: ReturnType<typeof pollCursor>,
  signedMessages: readonly SignedMessageValue[],
): RouterPollResult => ({
  kind: "batch",
  routerInstanceId: instance,
  signedMessages,
  pollCursor: cursor,
});

function canonicalCardTexts(input: CanonicalCardTextsInput): Effect.Effect<{
  readonly payloadText: string;
  readonly protectedText: string;
}> {
  const { byte, localAuthority, name, registryThumbprint } = input;
  const protectedText = canonicalize({
    alg: "Ed25519",
    kid: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${registryThumbprint}`,
    typ: "application/vnd.moltzap.agent-card+jws",
  });
  const payloadText = canonicalize({
    agentId: agentId(byte),
    agentName: Schema.decodeUnknownSync(AgentName)(name),
    issuedAt: "2026-08-13T12:00:00Z",
    kind: "agentCard",
    moltzapVersion: MOLTZAP_VERSION,
    principalId: Schema.decodeUnknownSync(PrincipalId)(
      identifier("prn_", byte),
    ),
    publicKey: AgentSigningAuthority.publicKey(localAuthority),
  });
  return protectedText === undefined || payloadText === undefined
    ? Effect.die("canonical test card encoding failed")
    : Effect.succeed({ payloadText, protectedText });
}

function scriptedRouterService(
  scripted: ScriptedRouter,
): Context.Tag.Service<typeof Router> {
  return {
    poll: scriptedPoll(scripted),
    send: scriptedSend(scripted),
  };
}

function scriptedPoll(
  scripted: ScriptedRouter,
): Context.Tag.Service<typeof Router>["poll"] {
  return (call) =>
    Effect.gen(function* () {
      yield* Ref.update(scripted.pollCalls, (calls) => [
        ...calls,
        { hasCursor: call.request.pollCursor !== undefined },
      ]);
      const result = yield* Ref.modify(scripted.polls, (results) => {
        const [head, ...tail] = results;
        return [head, tail] as const;
      });
      return (
        result ??
        (scripted.fallbackPoll === undefined
          ? yield* Effect.die("poll script exhausted")
          : yield* scripted.fallbackPoll)
      );
    });
}

function scriptedSend(
  scripted: ScriptedRouter,
): Context.Tag.Service<typeof Router>["send"] {
  return (call) =>
    Effect.gen(function* () {
      yield* Ref.update(scripted.sendCalls, (calls) => [
        ...calls,
        { request: call.request },
      ]);
      const result = yield* Ref.modify(scripted.sends, (results) => {
        const [head, ...tail] = results;
        return [head, tail] as const;
      });
      return result ?? (yield* Effect.die("send script exhausted"));
    });
}
