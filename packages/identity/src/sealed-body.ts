/** @file Sealed SignedMessage bodies: multi-recipient JWE bound to the sender AgentId. */

import { Data, Effect, Either, Encoding, Option, Schema } from "effect";
import { generalDecrypt, GeneralEncrypt } from "jose";
import type { VerifiedAgentCard } from "./agent-card.js";
import {
  agentOpeningPrivateKey,
  type AgentSigningAuthority,
  x25519PublicJwk,
} from "./agent-key.js";
import { decodeCanonicalJson, encodeCanonicalJson } from "./canonical-json.js";
import {
  AgentId,
  type AgentId as AgentIdValue,
  hasCanonicalBase64UrlLength,
} from "./identifiers.js";
import {
  compareAgentIds,
  MAXIMUM_BODY_BYTES,
  MAXIMUM_RECIPIENTS,
  type VerifiedSignedMessage,
} from "./signed-message.js";

const KEY_MANAGEMENT_ALGORITHM = "ECDH-ES+A256KW";
const CONTENT_ENCRYPTION_ALGORITHM = "A256GCM";
const SENDER_HEADER = "xyz.moltzap/sender";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_KEY_BYTES = 40;
const X25519_PUBLIC_KEY_BYTES = 32;

/**
 * Every sealed-body member except the ciphertext has a fixed length: the
 * sender AgentId, ephemeral keys, wrapped keys, IV, and tag. The JCS encoding
 * is therefore the base64url ciphertext plus these fixed byte counts. A single
 * recipient carries its `epk` in the protected header, and two or more each
 * carry one in their own entry.
 *
 * The outer members with IV and tag take 103 bytes. A single recipient adds a
 * 234-byte protected header and a 74-byte entry: 411. Two or more add a
 * 120-byte protected header and 171 bytes per entry including its separating
 * comma, less one byte because the last entry has none: 222 + 171R.
 */
const SINGLE_RECIPIENT_FIXED_BYTES = 411;
const MULTIPLE_RECIPIENT_FIXED_BYTES = 222;
const RECIPIENT_ENTRY_BYTES = 171;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const decodeCanonicalBase64Url = (value: string): Uint8Array | undefined =>
  Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => undefined,
    onRight: (bytes) =>
      Encoding.encodeBase64Url(bytes) === value ? bytes : undefined,
  });

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({
    parseOptions: {
      exact: true,
      onExcessProperty: "error",
    },
  });

const canonicalBase64Url = Schema.String.pipe(
  Schema.filter((value) => decodeCanonicalBase64Url(value) !== undefined),
);

const encodedBytes = (byteLength: number) =>
  Schema.String.pipe(
    Schema.filter((value) => hasCanonicalBase64UrlLength(value, byteLength)),
  );

const ephemeralPublicKey = exactStruct({
  crv: Schema.Literal("X25519"),
  kty: Schema.Literal("OKP"),
  x: encodedBytes(X25519_PUBLIC_KEY_BYTES),
});

const sealedBodyRepresentation = exactStruct({
  ciphertext: canonicalBase64Url,
  iv: encodedBytes(IV_BYTES),
  protected: canonicalBase64Url,
  recipients: Schema.Array(
    exactStruct({
      encrypted_key: encodedBytes(WRAPPED_KEY_BYTES),
      header: Schema.optional(exactStruct({ epk: ephemeralPublicKey })),
    }),
  ).pipe(Schema.minItems(1), Schema.maxItems(MAXIMUM_RECIPIENTS)),
  tag: encodedBytes(TAG_BYTES),
});

type SealedBodyRepresentation = typeof sealedBodyRepresentation.Type;

const protectedHeader = exactStruct({
  alg: Schema.Literal(KEY_MANAGEMENT_ALGORITHM),
  enc: Schema.Literal(CONTENT_ENCRYPTION_ALGORITHM),
  epk: Schema.optional(ephemeralPublicKey),
  [SENDER_HEADER]: AgentId,
});

type ProtectedHeader = typeof protectedHeader.Type;

const protectedHeaderJson = Schema.parseJson(protectedHeader);

/** A body cannot be sealed from the supplied sender to the supplied recipients. */
export class SealedBodySealingError extends Data.TaggedError(
  "SealedBodySealingError",
) {}

/** A verified SignedMessage body does not open as a sealed body for this agent. */
export class SealedBodyOpeningError extends Data.TaggedError(
  "SealedBodyOpeningError",
) {}

const sealingFailure = (): SealedBodySealingError =>
  new SealedBodySealingError();

const openingFailure = (): SealedBodyOpeningError =>
  new SealedBodyOpeningError();

interface SealInput {
  readonly senderAgentId: AgentIdValue;
  readonly recipientAgentCards: readonly VerifiedAgentCard[];
  readonly plaintext: Uint8Array;
}

const isRecipientCount = (recipientCount: number): boolean =>
  Number.isInteger(recipientCount) &&
  recipientCount >= 1 &&
  recipientCount <= MAXIMUM_RECIPIENTS;

const snapshotRecipients = (
  recipientAgentCards: readonly VerifiedAgentCard[],
): Effect.Effect<readonly VerifiedAgentCard[], SealedBodySealingError> =>
  Effect.gen(function* () {
    const recipients = yield* Effect.try({
      try: () => Array.from(recipientAgentCards),
      catch: sealingFailure,
    });
    const distinctAgentIds = new Set(recipients.map((card) => card.agentId));
    if (
      !isRecipientCount(recipients.length) ||
      distinctAgentIds.size !== recipients.length
    ) {
      return yield* new SealedBodySealingError();
    }
    return recipients.sort((left, right) =>
      compareAgentIds(left.agentId, right.agentId),
    );
  });

/**
 * Encrypts one plaintext to every recipient's AgentCard key and binds the
 * sender AgentId in the protected header.
 *
 * Recipient entries follow the canonical SignedMessage recipient order, so the
 * caller signs the returned bytes as a SignedMessage body from the same sender
 * to exactly these recipients. A sender that must read its own body includes
 * its card among the recipients.
 *
 * @param input Sender AgentId, 1 to 128 distinct verified recipient cards,
 * and the plaintext to seal.
 * @returns The canonical JSON bytes of the General JWE.
 */
const seal = (
  input: SealInput,
): Effect.Effect<Uint8Array, SealedBodySealingError> =>
  Effect.gen(function* () {
    const recipients = yield* snapshotRecipients(input.recipientAgentCards);
    const plaintext = yield* Effect.try({
      try: () => Uint8Array.from(input.plaintext),
      catch: sealingFailure,
    });
    const recipientKeys = yield* Either.all(
      recipients.map((card) => x25519PublicJwk(card.publicKey)),
    ).pipe(Either.mapLeft(sealingFailure));
    const encryption = new GeneralEncrypt(plaintext).setProtectedHeader({
      alg: KEY_MANAGEMENT_ALGORITHM,
      enc: CONTENT_ENCRYPTION_ALGORITHM,
      [SENDER_HEADER]: input.senderAgentId,
    });
    for (const recipientKey of recipientKeys) {
      encryption.addRecipient(recipientKey);
    }
    const representation = yield* Effect.tryPromise({
      try: () => encryption.encrypt(),
      catch: sealingFailure,
    });
    return yield* encodeCanonicalJson(representation).pipe(
      Effect.mapError(sealingFailure),
    );
  });

/**
 * Decodes the exact protected header without the JCS byte check that every
 * other Identity JSON value passes.
 *
 * The jose library serializes this header itself, and for a single recipient
 * it appends `epk` after the sender member, so the sealer cannot produce JCS
 * here.
 * A256GCM authenticates the exact header bytes, so no alternate spelling opens.
 *
 * @param encodedHeader The `protected` member of the General JWE.
 * @returns The decoded header.
 */
const decodeProtectedHeader = (
  encodedHeader: string,
): Effect.Effect<ProtectedHeader, SealedBodyOpeningError> =>
  Effect.gen(function* () {
    const headerText = yield* Effect.try({
      try: () =>
        utf8Decoder.decode(
          Encoding.decodeBase64Url(encodedHeader).pipe(Either.getOrThrow),
        ),
      catch: openingFailure,
    });
    return yield* Schema.decodeUnknown(protectedHeaderJson)(headerText, {
      exact: true,
      onExcessProperty: "error",
    }).pipe(Effect.mapError(openingFailure));
  });

/**
 * Checks the one ephemeral-key placement the sealer produces: the protected
 * header carries it for a single recipient, and each recipient header carries
 * its own otherwise.
 */
const hasExactEphemeralKeyPlacement = (
  representation: SealedBodyRepresentation,
  header: ProtectedHeader,
): boolean =>
  representation.recipients.length === 1
    ? header.epk !== undefined &&
      representation.recipients.every(
        (recipient) => recipient.header === undefined,
      )
    : header.epk === undefined &&
      representation.recipients.every(
        (recipient) => recipient.header !== undefined,
      );

type RecipientEntry = SealedBodyRepresentation["recipients"][number];

/**
 * Selects the one entry sealed to `agentId`. Entries follow the canonical
 * order of the SignedMessage recipient list, so the agent's position in that
 * list is its entry, and no other entry is tried.
 */
const recipientEntry = (
  representation: SealedBodyRepresentation,
  recipientAgentIds: readonly AgentIdValue[],
  agentId: AgentIdValue,
): Effect.Effect<RecipientEntry, SealedBodyOpeningError> => {
  if (representation.recipients.length !== recipientAgentIds.length) {
    return Effect.fail(new SealedBodyOpeningError());
  }
  const entry = representation.recipients[recipientAgentIds.indexOf(agentId)];
  return entry === undefined
    ? Effect.fail(new SealedBodyOpeningError())
    : Effect.succeed(entry);
};

interface OpenInput {
  readonly agentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
  readonly signedMessage: VerifiedSignedMessage;
}

/**
 * Decrypts a verified SignedMessage body sealed to the local agent.
 *
 * It refuses a body that is not an exact sealed body, a protected-header
 * sender that differs from the verified SignedMessage sender, an entry count
 * that differs from the SignedMessage recipient count, an agent the
 * SignedMessage does not name, and any authentication failure. An AgentCard
 * that does not belong to the authority selects an entry the authority cannot
 * unwrap. The SignedMessage MessageId is not bound, so a retry under a new
 * MessageId opens.
 *
 * @param input The local agent's AgentCard and authority, and the verified
 * SignedMessage.
 * @returns The sealed plaintext.
 */
const open = (
  input: OpenInput,
): Effect.Effect<Uint8Array, SealedBodyOpeningError> =>
  Effect.gen(function* () {
    const representation = yield* decodeCanonicalJson(
      sealedBodyRepresentation,
      input.signedMessage.body,
    ).pipe(Effect.mapError(openingFailure));
    const header = yield* decodeProtectedHeader(representation.protected);
    if (!hasExactEphemeralKeyPlacement(representation, header)) {
      return yield* new SealedBodyOpeningError();
    }
    if (header[SENDER_HEADER] !== input.signedMessage.senderAgentId) {
      return yield* new SealedBodyOpeningError();
    }
    const entry = yield* recipientEntry(
      representation,
      input.signedMessage.recipientAgentIds,
      input.agentCard.agentId,
    );
    const decrypted = yield* Effect.tryPromise({
      try: () =>
        generalDecrypt(
          { ...representation, recipients: [entry] },
          agentOpeningPrivateKey(input.signingAuthority),
          {
            keyManagementAlgorithms: [KEY_MANAGEMENT_ALGORITHM],
            contentEncryptionAlgorithms: [CONTENT_ENCRYPTION_ALGORITHM],
          },
        ),
      catch: openingFailure,
    });
    return decrypted.plaintext;
  });

const fixedByteLength = (recipientCount: number): number =>
  recipientCount === 1
    ? SINGLE_RECIPIENT_FIXED_BYTES
    : MULTIPLE_RECIPIENT_FIXED_BYTES + RECIPIENT_ENTRY_BYTES * recipientCount;

/**
 * Computes `ceil(4n / 3)`, the unpadded base64url length of `n` bytes, without
 * fractional arithmetic.
 *
 * @param byteLength Non-negative safe integer.
 * @returns The encoded length.
 */
const base64UrlLength = (byteLength: number): number => {
  const remainder = byteLength % 3;
  return byteLength + (byteLength - remainder) / 3 + (remainder === 0 ? 0 : 1);
};

interface SealedByteLengthInput {
  readonly plaintextByteLength: number;
  readonly recipientCount: number;
}

/**
 * Returns the exact length of the body `seal` produces, so a consumer checks a
 * SignedMessage body bound without reproducing the representation formula.
 *
 * @param input Plaintext length and recipient count.
 * @returns The sealed length, or none when the recipient count is not an
 * integer from 1 to 128 or the plaintext length is not a non-negative safe
 * integer.
 */
const sealedByteLength = (
  input: SealedByteLengthInput,
): Option.Option<number> => {
  if (
    !isRecipientCount(input.recipientCount) ||
    !Number.isSafeInteger(input.plaintextByteLength) ||
    input.plaintextByteLength < 0
  ) {
    return Option.none();
  }
  const byteLength =
    base64UrlLength(input.plaintextByteLength) +
    fixedByteLength(input.recipientCount);
  return Number.isSafeInteger(byteLength)
    ? Option.some(byteLength)
    : Option.none();
};

/**
 * Returns the largest plaintext whose sealed body fits one SignedMessage body.
 *
 * @param recipientCount Number of recipients.
 * @returns The largest plaintext length, or none when the recipient count is
 * not an integer from 1 to 128.
 */
const maximumPlaintextByteLength = (
  recipientCount: number,
): Option.Option<number> => {
  if (!isRecipientCount(recipientCount)) {
    return Option.none();
  }
  const ciphertextBudget = MAXIMUM_BODY_BYTES - fixedByteLength(recipientCount);
  return Option.some(Math.floor((3 * ciphertextBudget) / 4));
};

/**
 * Seals a SignedMessage body to its recipients, opens a verified sealed body,
 * and reports sealed sizes. `SignedMessage.sign` never seals; the caller
 * chooses which bodies to seal and signs the sealed bytes.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- The deep-module capability uses its domain name, as SignedMessage and AgentSigningAuthority do.
export const SealedBody = Object.freeze({
  seal,
  open,
  sealedByteLength,
  maximumPlaintextByteLength,
});
