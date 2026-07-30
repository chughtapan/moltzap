import { exportJWK, importPKCS8, type CryptoKey } from "jose";
import { Data, Effect, Redacted, Schema } from "effect";
import {
  Ed25519PublicKey,
  type Ed25519PublicKey as Ed25519PublicKeyValue,
} from "./ed25519-public-key.js";

declare const agentSigningAuthorityBrand: unique symbol;

/** Opaque authority over one imported Ed25519 private key. */
export interface AgentSigningAuthority {
  readonly [agentSigningAuthorityBrand]: "AgentSigningAuthority";
}

/** The supplied private-key material cannot act as an Ed25519 signer. */
export class InvalidAgentPrivateKeyError extends Data.TaggedError(
  "InvalidAgentPrivateKeyError",
) {}

type AuthorityState = Readonly<{
  privateKey: CryptoKey;
  publicKey: Ed25519PublicKeyValue;
}>;

const authorityState = new WeakMap<AgentSigningAuthority, AuthorityState>();

const getAuthorityState = (
  authority: AgentSigningAuthority,
): AuthorityState => {
  const state = authorityState.get(authority);
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The construction invariant inserts state before this opaque value escapes.
  return state!;
};

const fromPkcs8 = (
  pkcs8: Redacted.Redacted,
): Effect.Effect<AgentSigningAuthority, InvalidAgentPrivateKeyError> =>
  Effect.gen(function* () {
    // JOSE needs an extractable import to derive the public JWK, while the
    // authority retains a separate non-extractable import.
    const extractableKey = yield* Effect.tryPromise({
      try: () =>
        importPKCS8(Redacted.value(pkcs8), "Ed25519", {
          extractable: true,
        }),
      catch: () => new InvalidAgentPrivateKeyError(),
    });
    const exportedKey = yield* Effect.tryPromise({
      try: () => exportJWK(extractableKey),
      catch: () => new InvalidAgentPrivateKeyError(),
    });
    const publicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
      {
        crv: exportedKey.crv,
        kty: exportedKey.kty,
        x: exportedKey.x,
      },
      {
        exact: true,
        onExcessProperty: "error",
      },
    ).pipe(
      // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- The public contract intentionally represents every unusable private key with one empty error.
      Effect.mapError(() => new InvalidAgentPrivateKeyError()),
    );

    const privateKey = yield* Effect.tryPromise({
      try: () =>
        importPKCS8(Redacted.value(pkcs8), "Ed25519", {
          extractable: false,
        }),
      catch: () => new InvalidAgentPrivateKeyError(),
    });
    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- This assertion is safe because this module alone constructs values after inserting their WeakMap state.
    const authority = Object.freeze({}) as AgentSigningAuthority;
    authorityState.set(authority, { privateKey, publicKey });
    return authority;
  });

const publicKey = (authority: AgentSigningAuthority): Ed25519PublicKeyValue =>
  getAuthorityState(authority).publicKey;

/**
 * Returns the non-extractable key to identity-owned signed-artifact modules.
 *
 * @param authority Authority whose private key is needed.
 * @returns The authority's non-extractable private key.
 */
export const agentSigningPrivateKey = (
  authority: AgentSigningAuthority,
): CryptoKey => getAuthorityState(authority).privateKey;

/**
 * Loads and identifies one Ed25519 signing authority without exposing its
 * private key or a generic signing operation.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The approved Effect-style API uses one name for its opaque type and capability value.
export const AgentSigningAuthority = Object.freeze({
  fromPkcs8,
  publicKey,
});
