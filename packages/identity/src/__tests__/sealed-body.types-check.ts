/**
 * @file SealedBody exposes exactly seal, open, and two size functions. Seal
 * and open each have an exact input, a byte result, one empty error, and no
 * context. Open accepts only a VerifiedSignedMessage, so the sender and
 * recipient positions it relies on have passed signature verification. The
 * size functions are total and return Option.
 */

import type { Effect, Option } from "effect";
import type {
  AgentId,
  AgentSigningAuthority,
  SealedBody,
  SealedBodyOpeningError,
  SealedBodySealingError,
  SignedMessage,
  VerifiedAgentCard,
  VerifiedSignedMessage,
} from "../index.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type Seal = typeof SealedBody.seal;
type SealResult = ReturnType<Seal>;
type Open = typeof SealedBody.open;
type OpenResult = ReturnType<Open>;

type SealInputIsExact = Expect<
  Equal<
    Parameters<Seal>[0],
    {
      readonly senderAgentId: AgentId;
      readonly recipientAgentCards: readonly VerifiedAgentCard[];
      readonly plaintext: Uint8Array;
    }
  >
>;
type SealSuccessIsBytes = Expect<
  Equal<Effect.Effect.Success<SealResult>, Uint8Array>
>;
type SealFailureIsExact = Expect<
  Equal<Effect.Effect.Error<SealResult>, SealedBodySealingError>
>;
type SealNeedsNoContext = Expect<
  Equal<Effect.Effect.Context<SealResult>, never>
>;
type OpenInputIsExact = Expect<
  Equal<
    Parameters<Open>[0],
    {
      readonly agentCard: VerifiedAgentCard;
      readonly signingAuthority: AgentSigningAuthority;
      readonly signedMessage: VerifiedSignedMessage;
    }
  >
>;
type OpenRefusesUnverifiedMessages = Expect<
  Equal<
    SignedMessage extends Parameters<Open>[0]["signedMessage"] ? true : false,
    false
  >
>;
type OpenSuccessIsBytes = Expect<
  Equal<Effect.Effect.Success<OpenResult>, Uint8Array>
>;
type OpenFailureIsExact = Expect<
  Equal<Effect.Effect.Error<OpenResult>, SealedBodyOpeningError>
>;
type OpenNeedsNoContext = Expect<
  Equal<Effect.Effect.Context<OpenResult>, never>
>;
type SealedByteLengthIsExact = Expect<
  Equal<
    typeof SealedBody.sealedByteLength,
    (input: {
      readonly plaintextByteLength: number;
      readonly recipientCount: number;
    }) => Option.Option<number>
  >
>;
type MaximumPlaintextByteLengthIsExact = Expect<
  Equal<
    typeof SealedBody.maximumPlaintextByteLength,
    (recipientCount: number) => Option.Option<number>
  >
>;
type CapabilityIsExact = Expect<
  Equal<
    keyof typeof SealedBody,
    "maximumPlaintextByteLength" | "open" | "seal" | "sealedByteLength"
  >
>;

/** Compile-time evidence for the sealed-body public contract. */
export type SealedBodyCanaries = [
  SealInputIsExact,
  SealSuccessIsBytes,
  SealFailureIsExact,
  SealNeedsNoContext,
  OpenInputIsExact,
  OpenRefusesUnverifiedMessages,
  OpenSuccessIsBytes,
  OpenFailureIsExact,
  OpenNeedsNoContext,
  SealedByteLengthIsExact,
  MaximumPlaintextByteLengthIsExact,
  CapabilityIsExact,
];
