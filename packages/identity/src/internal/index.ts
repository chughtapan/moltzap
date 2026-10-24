/**
 * @file Identity capabilities reserved for workspace service compositions.
 * @internal
 */

import { Effect, Schema } from "effect";
import { GeneralSign } from "jose";
import {
  AgentCard,
  agentCardIssuedAtSchema,
  AgentCardVerificationError,
} from "../agent-card.js";
import {
  AgentSigningAuthority,
  agentSigningPrivateKey,
  ed25519PublicKeyThumbprintUri,
} from "../agent-key.js";
import { encodeCanonicalJson } from "../canonical-json.js";
import { hasCanonicalBase64UrlLength } from "../identifiers.js";
import { WIRE_VERSION } from "../version.js";
import { WIRE_PROFILES } from "../wire-profile.js";

/** Closed Registry wire grammar shared by client encoding and service admission. */
export * as RegistryApi from "../registry/contract.js";
/** Bootstrap verification keeps private signature proofs inside service admission. */
export {
  type VerifiedHttpSignature,
  verifyBootstrapRequest,
} from "../http-signature.js";
/** HTTP failures use Identity's exact closed response representation. */
export { httpEnvelope, type HttpEnvelopeError } from "../http-errors.js";

/** Bootstrap framing admits the key representation before cryptographic validation. */
export const bootstrapAuthentication = Object.freeze({
  publicKeyRepresentation: Schema.Struct({
    crv: Schema.Literal("Ed25519"),
    kty: Schema.Literal("OKP"),
    x: Schema.String.pipe(
      Schema.filter((value) => hasCanonicalBase64UrlLength(value, 32)),
    ),
  }),
});

interface CardSigning {
  readonly issuedAt: typeof agentCardIssuedAtSchema;
  readonly publicKeyId: typeof ed25519PublicKeyThumbprintUri;
  readonly sign: (
    payload: unknown,
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
  payload: unknown,
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
