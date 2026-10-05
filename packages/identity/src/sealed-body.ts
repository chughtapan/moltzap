/**
 * @file Sealed SignedMessage bodies: multi-recipient JWE bound to the sender
 * AgentId and committed to one plaintext.
 */

import { Data, Effect, Either, Encoding, Option, Schema } from "effect";
import {
  type CryptoKey,
  exportJWK,
  generalDecrypt,
  GeneralEncrypt,
  generateKeyPair,
} from "jose";
import type { VerifiedAgentCard } from "./agent-card.js";
import {
  agentOpeningPrivateKey,
  AgentSigningAuthority,
  SEALED_BODY_KEY_MANAGEMENT_ALGORITHM,
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

const CONTENT_ENCRYPTION_ALGORITHM = "A256GCM";
const COMMITMENT_HEADER = "xyz.moltzap/commitment";
const SENDER_HEADER = "xyz.moltzap/sender";
const COMMITMENT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_KEY_BYTES = 40;
const X25519_PUBLIC_KEY_BYTES = 32;

/**
 * A random salt precedes the plaintext inside the ciphertext, so the
 * commitment in the protected header reveals nothing about the plaintext.
 */
const SALT_BYTES = 32;

/**
 * Every sealed-body member except the ciphertext has a fixed length: the
 * commitment, sender AgentId, shared ephemeral key, wrapped keys, IV, and tag.
 * The JCS encoding is therefore the base64url of the salted plaintext plus
 * these fixed byte counts.
 *
 * The outer member names, punctuation, IV, and tag take 103 bytes, and the
 * base64url protected header, which carries the one ephemeral key, takes 328.
 * Each entry takes 74 bytes and a separating comma, less one byte because the
 * last entry has none: 103 + 328 - 1 + 75R = 430 + 75R.
 */
const FIXED_BYTES = 430;
const RECIPIENT_ENTRY_BYTES = 75;

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

const encodedCommitment = encodedBytes(COMMITMENT_BYTES);

const ephemeralPublicKey = exactStruct({
  crv: Schema.Literal("X25519"),
  kty: Schema.Literal("OKP"),
  x: encodedBytes(X25519_PUBLIC_KEY_BYTES),
});

type EphemeralPublicKey = typeof ephemeralPublicKey.Type;

/**
 * Recipient entries carry only a wrapped key: the one ephemeral key sits in
 * the protected header, so an entry `header` is refused.
 */
const sealedBodyRepresentation = exactStruct({
  ciphertext: canonicalBase64Url,
  iv: encodedBytes(IV_BYTES),
  protected: canonicalBase64Url,
  recipients: Schema.Array(
    exactStruct({ encrypted_key: encodedBytes(WRAPPED_KEY_BYTES) }),
  ).pipe(Schema.minItems(1), Schema.maxItems(MAXIMUM_RECIPIENTS)),
  tag: encodedBytes(TAG_BYTES),
});

type SealedBodyRepresentation = typeof sealedBodyRepresentation.Type;

const protectedHeader = exactStruct({
  alg: Schema.Literal(SEALED_BODY_KEY_MANAGEMENT_ALGORITHM),
  enc: Schema.Literal(CONTENT_ENCRYPTION_ALGORITHM),
  epk: ephemeralPublicKey,
  [COMMITMENT_HEADER]: encodedCommitment,
  [SENDER_HEADER]: AgentId,
});

type ProtectedHeader = typeof protectedHeader.Type;

const protectedHeaderJson = Schema.parseJson(protectedHeader);

/**
 * Builds the protected-header members in their one accepted order. The sealer
 * hands jose this object, and the opener rebuilds it to require that exact
 * spelling.
 *
 * `epk` comes last with its members in `x`, `crv`, `kty` order. That is the
 * spelling jose writes when it rewrites `epk` in place for a single
 * recipient, so every recipient count produces the same header.
 *
 * @param commitment Base64url SHA-256 of the salted plaintext.
 * @param senderAgentId Sender bound by the header.
 * @param epk Public half of the body's one ephemeral key.
 * @returns The members in serialization order.
 */
const protectedHeaderMembers = (
  commitment: string,
  senderAgentId: AgentIdValue,
  epk: EphemeralPublicKey,
) => ({
  alg: SEALED_BODY_KEY_MANAGEMENT_ALGORITHM,
  enc: CONTENT_ENCRYPTION_ALGORITHM,
  [COMMITMENT_HEADER]: commitment,
  [SENDER_HEADER]: senderAgentId,
  epk: { x: epk.x, crv: epk.crv, kty: epk.kty },
});

/**
 * Commits to the salted plaintext. A256GCM does not bind the content key to
 * the ciphertext, so a sender could wrap a different key for each recipient
 * over one ciphertext and tag that authenticate under both. The commitment in
 * the authenticated header lets at most one plaintext open.
 *
 * @param saltedPlaintext Salt followed by the plaintext.
 * @param failure Error for a digest failure.
 * @returns The base64url SHA-256 digest.
 */
const commitmentOf = <E>(saltedPlaintext: Uint8Array, failure: () => E) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(saltedPlaintext)),
    catch: failure,
  }).pipe(
    Effect.map((digest) => Encoding.encodeBase64Url(new Uint8Array(digest))),
  );

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
 * Generates the one ephemeral X25519 key of a sealed body. The private key is
 * extractable because jose exports the public half from it when the runtime
 * lacks `SubtleCrypto.getPublicKey`, as on Node 22; jose generates its own
 * ephemeral keys extractable for the same reason.
 *
 * @returns The private key and its public JWK.
 */
const generateEphemeralKey = (): Effect.Effect<
  { readonly privateKey: CryptoKey; readonly publicKey: EphemeralPublicKey },
  SealedBodySealingError
> =>
  Effect.gen(function* () {
    const keyPair = yield* Effect.tryPromise({
      try: () =>
        generateKeyPair(SEALED_BODY_KEY_MANAGEMENT_ALGORITHM, {
          crv: "X25519",
          extractable: true,
        }),
      catch: sealingFailure,
    });
    const publicJwk = yield* Effect.tryPromise({
      try: () => exportJWK(keyPair.publicKey),
      catch: sealingFailure,
    });
    const publicKey = yield* Schema.decodeUnknown(ephemeralPublicKey)({
      crv: publicJwk.crv,
      kty: publicJwk.kty,
      x: publicJwk.x,
    }).pipe(Effect.mapError(sealingFailure));
    return { privateKey: keyPair.privateKey, publicKey };
  });

/**
 * Encrypts one plaintext to every recipient's AgentCard key, binds the sender
 * AgentId in the protected header, and commits the header to the salted
 * plaintext.
 *
 * One ephemeral X25519 key serves every recipient: its public half sits once
 * in the protected header, and each entry carries only that recipient's
 * wrapped content key. Reusing one ephemeral key across the recipients of a
 * single message is a known-secure construction for Diffie-Hellman key
 * encapsulation (Kurosawa, PKC 2002; Bellare, Boldyreva and Staddon, PKC
 * 2003), and it saves an ephemeral key per recipient. The jose library also
 * writes the shared key into each entry header; seal drops those copies.
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
    const saltedPlaintext = yield* Effect.try({
      try: () => {
        const bytes = new Uint8Array(SALT_BYTES + input.plaintext.byteLength);
        bytes.set(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
        bytes.set(input.plaintext, SALT_BYTES);
        return bytes;
      },
      catch: sealingFailure,
    });
    const commitment = yield* commitmentOf(saltedPlaintext, sealingFailure);
    const recipientKeys = yield* Either.all(
      recipients.map((card) => x25519PublicJwk(card.publicKey)),
    ).pipe(Either.mapLeft(sealingFailure));
    const ephemeralKey = yield* generateEphemeralKey();
    const encryption = new GeneralEncrypt(saltedPlaintext).setProtectedHeader(
      protectedHeaderMembers(
        commitment,
        input.senderAgentId,
        ephemeralKey.publicKey,
      ),
    );
    for (const recipientKey of recipientKeys) {
      encryption
        .addRecipient(recipientKey)
        .setKeyManagementParameters({ epk: ephemeralKey.privateKey });
    }
    const representation = yield* Effect.tryPromise({
      try: () => encryption.encrypt(),
      catch: sealingFailure,
    });
    return yield* encodeCanonicalJson({
      ...representation,
      recipients: representation.recipients.map((recipient) => ({
        encrypted_key: recipient.encrypted_key,
      })),
    }).pipe(Effect.mapError(sealingFailure));
  });

/**
 * Rebuilds the one spelling a sealer produces for a header: `JSON.stringify`
 * of the members in `protectedHeaderMembers` order.
 *
 * @param header Decoded protected header.
 * @returns The exact header text a sealer produces.
 */
const expectedHeaderText = (header: ProtectedHeader): string =>
  JSON.stringify(
    protectedHeaderMembers(
      header[COMMITMENT_HEADER],
      header[SENDER_HEADER],
      header.epk,
    ),
  );

/**
 * Decodes the protected header and requires the exact bytes a sealer writes.
 *
 * The header is not JCS: `epk` follows the other members, with its own
 * members in jose's order. A256GCM authenticates whatever bytes the sender
 * chose, so the byte comparison is what stops a sender from respelling the
 * header with reordered, repeated, escaped, or spaced members. It compares
 * the encoded bytes rather than the decoded text, because the UTF-8 decoder
 * strips a leading byte-order mark.
 *
 * @param encodedHeader The canonical base64url `protected` member of the
 * General JWE.
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
    const header = yield* Schema.decodeUnknown(protectedHeaderJson)(
      headerText,
      { exact: true, onExcessProperty: "error" },
    ).pipe(Effect.mapError(openingFailure));
    if (
      Encoding.encodeBase64Url(expectedHeaderText(header)) !== encodedHeader
    ) {
      return yield* new SealedBodyOpeningError();
    }
    return header;
  });

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
 * It first refuses an AgentCard whose key is not the authority's Ed25519 key.
 * A successful unwrap cannot prove that pairing: a sender may wrap any entry
 * to any key, and an Ed25519 key and its negation share one X25519 key.
 *
 * It then refuses a body that is not an exact sealed body, including one whose
 * ephemeral key is missing from the protected header or repeated in an entry
 * header, a protected-header
 * sender that differs from the verified SignedMessage sender, an entry count
 * that differs from the SignedMessage recipient count, an agent the
 * SignedMessage does not name, any authentication failure, and a decryption
 * that does not match the header commitment. Every recipient that opens a
 * given body therefore obtains the same plaintext, but a sender can still make
 * a body open for some recipients and not others. The SignedMessage MessageId
 * is not bound, so a retry under a new MessageId opens.
 *
 * @param input The local agent's AgentCard and authority, and the verified
 * SignedMessage.
 * @returns The sealed plaintext.
 */
const open = (
  input: OpenInput,
): Effect.Effect<Uint8Array, SealedBodyOpeningError> =>
  Effect.gen(function* () {
    if (
      AgentSigningAuthority.publicKey(input.signingAuthority).x !==
      input.agentCard.publicKey.x
    ) {
      return yield* new SealedBodyOpeningError();
    }
    const representation = yield* decodeCanonicalJson(
      sealedBodyRepresentation,
      input.signedMessage.body,
    ).pipe(Effect.mapError(openingFailure));
    const header = yield* decodeProtectedHeader(representation.protected);
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
            keyManagementAlgorithms: [SEALED_BODY_KEY_MANAGEMENT_ALGORITHM],
            contentEncryptionAlgorithms: [CONTENT_ENCRYPTION_ALGORITHM],
          },
        ),
      catch: openingFailure,
    });
    const commitment = yield* commitmentOf(decrypted.plaintext, openingFailure);
    if (
      decrypted.plaintext.byteLength < SALT_BYTES ||
      commitment !== header[COMMITMENT_HEADER]
    ) {
      return yield* new SealedBodyOpeningError();
    }
    return decrypted.plaintext.slice(SALT_BYTES);
  });

const fixedByteLength = (recipientCount: number): number =>
  FIXED_BYTES + RECIPIENT_ENTRY_BYTES * recipientCount;

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
 * integer from 1 to 128, the plaintext length is not a non-negative safe
 * integer, or the sealed length would exceed `Number.MAX_SAFE_INTEGER`.
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
    base64UrlLength(input.plaintextByteLength + SALT_BYTES) +
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
  return Option.some(Math.floor((3 * ciphertextBudget) / 4) - SALT_BYTES);
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
