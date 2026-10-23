/** @file Registry-owned immutable AgentCard issuance and storage encoding. */

import { Effect, Schema } from "effect";
import { GeneralSign } from "jose";
import type {
  AgentId as AgentIdValue,
  AgentName as AgentNameValue,
  PrincipalId as PrincipalIdValue,
} from "../identifiers.js";
import {
  AgentCard,
  agentCardIssuedAtSchema,
  AgentCardVerificationError,
  type VerifiedAgentCard,
} from "../agent-card.js";
import {
  AgentSigningAuthority,
  agentSigningPrivateKey,
  ed25519PublicKeyThumbprintUri,
  type Ed25519PublicKey as Ed25519PublicKeyValue,
} from "../agent-key.js";
import { encodeCanonicalJson } from "../canonical-json.js";
import { WIRE_VERSION } from "../version.js";
import { WIRE_PROFILES } from "../wire-profile.js";
import { WireVersions } from "../wire-versions.js";
import { registryAgentCardCodec } from "./contract.js";

/** Whole-second UTC issuance evidence carried by an AgentCard. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the package-owned domain name they decode.
export const AgentCardIssuedAt = agentCardIssuedAtSchema;
/** Validated nominal value decoded by AgentCardIssuedAt. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one package boundary model.
export type AgentCardIssuedAt = typeof AgentCardIssuedAt.Type;

const AGENT_CARD_TYPE = WIRE_PROFILES[WIRE_VERSION].agentCardType;
const verificationFailure = (): AgentCardVerificationError =>
  new AgentCardVerificationError();

interface IssueAgentCardInput {
  readonly agentId: AgentIdValue;
  readonly principalId: PrincipalIdValue;
  readonly agentName: AgentNameValue;
  readonly publicKey: Ed25519PublicKeyValue;
  readonly issuedAt: AgentCardIssuedAt;
  readonly registrySigningAuthority: AgentSigningAuthority;
}

/**
 * Issues one exact AgentCard for Registry storage.
 *
 * @param input Complete identity fields and Registry signing authority.
 * @returns A Registry-verified immutable AgentCard.
 */
export const issueAgentCard = (
  input: IssueAgentCardInput,
): Effect.Effect<VerifiedAgentCard, AgentCardVerificationError> =>
  Effect.gen(function* () {
    const payloadBytes = yield* encodeCanonicalJson({
      kind: "agentCard",
      sharnessVersion: yield* WireVersions.emitted,
      agentId: input.agentId,
      principalId: input.principalId,
      agentName: input.agentName,
      publicKey: input.publicKey,
      issuedAt: input.issuedAt,
    }).pipe(Effect.mapError(verificationFailure));
    const kid = yield* ed25519PublicKeyThumbprintUri(
      AgentSigningAuthority.publicKey(input.registrySigningAuthority),
    ).pipe(Effect.mapError(verificationFailure));
    const representation = yield* Effect.tryPromise({
      try: () =>
        new GeneralSign(payloadBytes)
          .addSignature(agentSigningPrivateKey(input.registrySigningAuthority))
          .setProtectedHeader({
            alg: "Ed25519",
            kid,
            typ: AGENT_CARD_TYPE,
          })
          .sign(),
      catch: verificationFailure,
    });
    const card = yield* Schema.decodeUnknown(AgentCard)(representation).pipe(
      Effect.mapError(verificationFailure),
    );
    return yield* AgentCard.verify({
      agentCard: card,
      registrySignerPublicKey: AgentSigningAuthority.publicKey(
        input.registrySigningAuthority,
      ),
    });
  }).pipe(Effect.withSpan("issueAgentCard"));

/**
 * JCS representation bytes retained by a parsed AgentCard.
 *
 * @param agentCard Parsed AgentCard whose retained bytes are requested.
 * @returns The complete canonical General JWS bytes.
 */
export const encodeAgentCard = (
  agentCard: AgentCard,
): Effect.Effect<Uint8Array, AgentCardVerificationError> => {
  return registryAgentCardCodec
    .encode(agentCard)
    .pipe(Effect.mapError(verificationFailure));
};
