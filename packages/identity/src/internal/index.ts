/**
 * @file Identity capabilities reserved for workspace service compositions.
 * @internal
 */

import { Effect, Schema } from "effect";
import { GeneralSign } from "jose";
import type { AgentId, AgentName, PrincipalId } from "../identifiers.js";
import {
  AgentCard,
  agentCardIssuedAtSchema,
  AgentCardVerificationError,
} from "../agent-card.js";
import {
  AgentSigningAuthority,
  agentSigningPrivateKey,
  type Ed25519PublicKey,
  ed25519PublicKeyThumbprintUri,
} from "../agent-key.js";
import { encodeCanonicalJson } from "../canonical-json.js";
import { WIRE_VERSION } from "../version.js";
import { WIRE_PROFILES } from "../wire-profile.js";

/** Closed Registry wire grammar shared by client encoding and service admission. */
export {
  HEALTH_PATH,
  KNOWN_PATHS,
  LIST_BODY_CAP,
  LIST_PATH,
  LIST_ROUTE,
  listResultSchema,
  LOOKUP_BODY_CAP,
  LOOKUP_PATH,
  LOOKUP_ROUTE,
  lookupResultSchema,
  REGISTER_BODY_CAP,
  REGISTER_PATH,
  REGISTER_ROUTE,
  registerResultSchema,
  registrationBody,
  registryAgentCardCodec,
  registryListCodec,
  registryLookupCodec,
  registryRegisterCodec,
} from "../registry/contract.js";
/** Bootstrap verification keeps private signature proofs inside service admission. */
export {
  type VerifiedHttpSignature,
  verifyBootstrapRequest,
} from "../http-signature.js";

/** Complete immutable claims accepted by the card-signing capability. */
export interface AgentCardClaims {
  readonly kind: "agentCard";
  readonly sharnessVersion: string;
  readonly agentId: AgentId;
  readonly principalId: PrincipalId;
  readonly agentName: AgentName;
  readonly publicKey: Ed25519PublicKey;
  readonly issuedAt: typeof agentCardIssuedAtSchema.Type;
}

interface CardSigning {
  readonly issuedAt: typeof agentCardIssuedAtSchema;
  readonly publicKeyId: typeof ed25519PublicKeyThumbprintUri;
  readonly sign: (
    payload: AgentCardClaims,
    authority: AgentSigningAuthority,
  ) => Effect.Effect<AgentCard, AgentCardVerificationError>;
}

/** Card signing retains private key access and wire-profile details inside Identity. */
export const agentCardSigning: CardSigning = Object.freeze({
  issuedAt: agentCardIssuedAtSchema,
  publicKeyId: ed25519PublicKeyThumbprintUri,
  sign: signCardPayload,
});

function signCardPayload(
  payload: AgentCardClaims,
  authority: AgentSigningAuthority,
): Effect.Effect<AgentCard, AgentCardVerificationError> {
  return Effect.gen(function* () {
    const failure = () => new AgentCardVerificationError();
    const bytes = yield* encodeCanonicalJson(payload).pipe(
      Effect.mapError(failure),
    );
    const kid = yield* ed25519PublicKeyThumbprintUri(
      AgentSigningAuthority.publicKey(authority),
    ).pipe(Effect.mapError(failure));
    const representation = yield* Effect.tryPromise({
      try: () =>
        new GeneralSign(bytes)
          .addSignature(agentSigningPrivateKey(authority))
          .setProtectedHeader({
            alg: "Ed25519",
            kid,
            typ: WIRE_PROFILES[WIRE_VERSION].agentCardType,
          })
          .sign(),
      catch: failure,
    });
    return yield* Schema.decodeUnknown(AgentCard)(representation).pipe(
      Effect.mapError(failure),
    );
  }).pipe(Effect.withSpan("agentCardSigning"));
}
