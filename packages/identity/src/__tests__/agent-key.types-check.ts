/**
 * @file The signing authority exposes only key import and public-key projection.
 * Its Effect error remains exact, and no string-named member reveals private
 * key, JOSE, WebCrypto, or generic signing machinery. Consumers hold the
 * authority to sign, so any added member would expose key material or an
 * unaudited signing path to them.
 */

import type { Effect, Redacted } from "effect";
import type {
  AgentSigningAuthority,
  AgentSigningAuthority as AgentSigningAuthorityValue,
  Ed25519PublicKey,
  InvalidAgentPrivateKeyError,
} from "../index.js";

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- `Probe` stays generic so TypeScript compares the two deferred conditional types by identity. */
/**
 * True only when the two types are identical, so an added optional property
 * or a dropped `readonly` modifier fails the canary.
 */
type Equal<Left, Right> =
  (<Probe>() => Probe extends Left ? 1 : 2) extends <
    Probe,
  >() => Probe extends Right ? 1 : 2
    ? true
    : false;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters -- Restore repository defaults after the identity helper. */
type Expect<Value extends true> = Value;

type FromPkcs8 = typeof AgentSigningAuthority.fromPkcs8;
type FromPkcs8Result = ReturnType<FromPkcs8>;
type InputIsRedacted = Expect<
  Equal<Parameters<FromPkcs8>[0], Redacted.Redacted>
>;
type ImportSuccessIsAuthority = Expect<
  Equal<Effect.Effect.Success<FromPkcs8Result>, AgentSigningAuthorityValue>
>;
type ImportFailureIsExact = Expect<
  Equal<Effect.Effect.Error<FromPkcs8Result>, InvalidAgentPrivateKeyError>
>;
type ImportNeedsNoContext = Expect<
  Equal<Effect.Effect.Context<FromPkcs8Result>, never>
>;
type PublicKeyIsTotal = Expect<
  Equal<ReturnType<typeof AgentSigningAuthority.publicKey>, Ed25519PublicKey>
>;
type PublicCapabilityIsExact = Expect<
  Equal<keyof typeof AgentSigningAuthority, "fromPkcs8" | "publicKey">
>;
type AuthorityHasNoStringMembers = Expect<
  Equal<Extract<keyof AgentSigningAuthorityValue, string>, never>
>;

/** Compile-time evidence for the signing authority's public contract. */
export type AgentSigningAuthorityCanaries = [
  InputIsRedacted,
  ImportSuccessIsAuthority,
  ImportFailureIsExact,
  ImportNeedsNoContext,
  PublicKeyIsTotal,
  PublicCapabilityIsExact,
  AuthorityHasNoStringMembers,
];
