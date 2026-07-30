/**
 * The signing authority exposes only key import and public-key projection.
 * Its Effect error remains exact, and no string-named member reveals private
 * key, JOSE, WebCrypto, or generic signing machinery.
 */

import type {
  AgentSigningAuthority,
  AgentSigningAuthority as AgentSigningAuthorityValue,
  Ed25519PublicKey,
  InvalidAgentPrivateKeyError,
} from "./index.js";
import type { Effect, Redacted } from "effect";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
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
