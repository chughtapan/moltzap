/** @file SealedBody round trips, sender binding, refusals, retry, and size. */

import { Effect, Either, Encoding, Option, Redacted, Schema } from "effect";
import * as fc from "fast-check";
import { exportJWK, GeneralEncrypt, generateKeyPair } from "jose";
import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import {
  AgentCardIssuedAt,
  issueAgentCard,
  type VerifiedAgentCard,
} from "../agent-card.js";
import {
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  Ed25519PublicKey,
  x25519PublicJwk,
} from "../agent-key.js";
import { encodeCanonicalJson } from "../canonical-json.js";
import { AgentId, AgentName, PrincipalId } from "../identifiers.js";
import {
  SealedBody,
  SealedBodyOpeningError,
  SealedBodySealingError,
} from "../sealed-body.js";
import {
  MessageId,
  SignedMessage,
  SignedMessageSigningError,
  type VerifiedSignedMessage,
} from "../signed-message.js";

const SENDER_HEADER = "xyz.moltzap/sender";
/**
 * Building fixtures dominates these tests: every group member costs an
 * Ed25519 key, two PKCS#8 imports, and an issued AgentCard, and the largest
 * groups have 129 members and seal about 256 KB to 128 recipients. Loaded CI
 * hosts need more than the default five seconds.
 */
const KEY_AGREEMENT_HEAVY_TIMEOUT_MS = 60_000;
const SIGNED_MESSAGE_BODY_CAP = 262_144;

/**
 * At 32 recipients a sealed body is `ceil(4N / 3) + 5,694` bytes, so this is
 * the largest plaintext whose sealed body fits the SignedMessage body cap.
 */
const LARGEST_32_RECIPIENT_PLAINTEXT_BYTES = 192_337;
const PLAINTEXT_TEXT = "sealed outer body";
const FIXTURE_CONCURRENCY = 8;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

interface Member {
  readonly agentCard: VerifiedAgentCard;
  readonly authority: AgentSigningAuthorityValue;
}

const rawSealedBody = Schema.Struct({
  ciphertext: Schema.String,
  iv: Schema.String,
  protected: Schema.String,
  recipients: Schema.Array(
    Schema.Struct({
      encrypted_key: Schema.String,
      header: Schema.optional(Schema.Unknown),
    }),
  ),
  tag: Schema.String,
});
type RawSealedBody = typeof rawSealedBody.Type;

const rawProtectedHeader = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const makeAuthority = () =>
  AgentSigningAuthority.fromPkcs8(
    Redacted.make(
      generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
    ),
  );

const issueCard = (
  registrySigningAuthority: AgentSigningAuthorityValue,
  byte: number,
  publicKey: Ed25519PublicKey,
) =>
  issueAgentCard({
    agentId: Schema.decodeUnknownSync(AgentId)(identifier("agt_", byte)),
    principalId: Schema.decodeUnknownSync(PrincipalId)(
      identifier("prn_", byte),
    ),
    agentName: Schema.decodeUnknownSync(AgentName)(`member-${byte}`),
    publicKey,
    issuedAt: Schema.decodeUnknownSync(AgentCardIssuedAt)(
      "2026-10-05T12:00:00Z",
    ),
    registrySigningAuthority,
  });

const makeMember = (
  registrySigningAuthority: AgentSigningAuthorityValue,
  byte: number,
) =>
  Effect.gen(function* () {
    const authority = yield* makeAuthority();
    const agentCard = yield* issueCard(
      registrySigningAuthority,
      byte,
      AgentSigningAuthority.publicKey(authority),
    );
    const member: Member = { agentCard, authority };
    return member;
  });

/**
 * Builds a sender, a peer, an outsider, and a recipient list that starts with
 * the sender, then the peer, then further members up to `recipientCount`.
 *
 * @param recipientCount Number of recipients, sender included.
 * @returns The named members and the recipient list.
 */
const makeGroup = (recipientCount: number) =>
  Effect.gen(function* () {
    const registrySigningAuthority = yield* makeAuthority();
    const sender = yield* makeMember(registrySigningAuthority, 1);
    const peer = yield* makeMember(registrySigningAuthority, 2);
    const outsider = yield* makeMember(registrySigningAuthority, 255);
    const others = yield* Effect.all(
      Array.from(Array(Math.max(recipientCount - 2, 0)).keys(), (index) =>
        makeMember(registrySigningAuthority, index + 3),
      ),
      { concurrency: FIXTURE_CONCURRENCY },
    );
    const recipients = [sender, peer, ...others].slice(0, recipientCount);
    return { sender, peer, outsider, recipients, registrySigningAuthority };
  });

type Group = Effect.Effect.Success<ReturnType<typeof makeGroup>>;

const sealFrom = (
  sender: Member,
  recipients: readonly Member[],
  plaintext: Uint8Array,
) =>
  SealedBody.seal({
    senderAgentId: sender.agentCard.agentId,
    recipientAgentCards: recipients.map((member) => member.agentCard),
    plaintext,
  });

const signBody = (
  signer: Member,
  recipients: readonly Member[],
  body: Uint8Array,
  messageIdByte = 1,
) =>
  SignedMessage.sign({
    agentCard: signer.agentCard,
    signingAuthority: signer.authority,
    recipientAgentIds: new Set(
      recipients.map((member) => member.agentCard.agentId),
    ),
    messageId: Schema.decodeUnknownSync(MessageId)(
      identifier("msg_", messageIdByte),
    ),
    body,
  });

const openAs = (member: Member, signedMessage: VerifiedSignedMessage) =>
  SealedBody.open({
    agentCard: member.agentCard,
    signingAuthority: member.authority,
    signedMessage,
  });

const readSealedBody = (sealed: Uint8Array): RawSealedBody =>
  Schema.decodeUnknownSync(Schema.parseJson(rawSealedBody))(
    utf8Decoder.decode(sealed),
  );

const readProtectedHeader = (body: RawSealedBody) =>
  Schema.decodeUnknownSync(Schema.parseJson(rawProtectedHeader))(
    utf8Decoder.decode(
      Encoding.decodeBase64Url(body.protected).pipe(Either.getOrThrow),
    ),
  );

const writeProtectedHeader = (header: unknown): string =>
  Encoding.encodeBase64Url(JSON.stringify(header));

/**
 * Replaces the first base64url character, which encodes the six high bits of
 * the first byte, so the result stays canonical and changes one byte.
 *
 * @param value Canonical base64url text.
 * @returns The same text with a different first byte.
 */
const flipFirstByte = (value: string): string =>
  `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Sets the lowest bit of the final base64url character. When the text length
 * is not a multiple of four that bit is padding, which a canonical spelling
 * leaves clear, so the result is a noncanonical spelling of the same bytes.
 * The jose library decodes such a spelling and opens the body, so only the
 * representation check refuses it.
 *
 * @param value Canonical base64url text whose length is not a multiple of four.
 * @returns A noncanonical spelling of the same bytes.
 */
const respellFinalCharacter = (value: string): string =>
  `${value.slice(0, -1)}${BASE64URL_ALPHABET.charAt(BASE64URL_ALPHABET.indexOf(value.slice(-1)) + 1)}`;

const plaintext = utf8Encoder.encode(PLAINTEXT_TEXT);

/**
 * Seals `bytes` from the sender to the group, then checks that the peer opens
 * exactly `bytes` and that `sealedByteLength` reports the sealed length.
 *
 * @param group Sender, peer, and recipients.
 * @param bytes Plaintext to seal.
 * @returns Completion once both checks pass.
 */
const expectExactRoundTrip = (group: Group, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const sealed = yield* sealFrom(group.sender, group.recipients, bytes);
    const signedMessage = yield* signBody(
      group.sender,
      group.recipients,
      sealed,
    );

    expect(yield* openAs(group.peer, signedMessage)).toEqual(bytes);
    expect(
      SealedBody.sealedByteLength({
        plaintextByteLength: bytes.byteLength,
        recipientCount: group.recipients.length,
      }),
    ).toStrictEqual(Option.some(sealed.byteLength));
  });

/**
 * Runs `expectExactRoundTrip` over generated plaintexts of 0 to 2,048 bytes.
 *
 * @param group Sender, peer, and recipients.
 * @returns The fast-check run, rejecting with the shrunk counterexample.
 */
const generatedPlaintextsRoundTrip = (group: Group) =>
  fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 2048 }), (bytes) =>
      Effect.runPromise(expectExactRoundTrip(group, bytes)),
    ),
    { numRuns: 16 },
  );

/**
 * Seals `plaintext` to the sender and peer with one ephemeral key named in
 * the protected header, then drops the per-recipient copies jose adds.
 *
 * @param sender Sender and first recipient.
 * @param peer Second recipient.
 * @returns Canonical bytes of a JWE that jose opens but SealedBody refuses.
 */
const sealWithSharedEphemeralKey = (sender: Member, peer: Member) =>
  Effect.gen(function* () {
    const ephemeral = yield* Effect.tryPromise({
      try: () =>
        generateKeyPair("ECDH-ES+A256KW", { crv: "X25519", extractable: true }),
      catch: () => new Error("ephemeral key generation failed"),
    });
    const ephemeralPublicKey = yield* Effect.tryPromise({
      try: () => exportJWK(ephemeral.publicKey),
      catch: () => new Error("ephemeral key export failed"),
    });
    const sharedEphemeralKey = { epk: ephemeral.privateKey };
    const representation = yield* Effect.tryPromise({
      try: () =>
        new GeneralEncrypt(plaintext)
          .setProtectedHeader({
            alg: "ECDH-ES+A256KW",
            enc: "A256GCM",
            epk: {
              crv: ephemeralPublicKey.crv,
              kty: ephemeralPublicKey.kty,
              x: ephemeralPublicKey.x,
            },
            [SENDER_HEADER]: sender.agentCard.agentId,
          })
          .addRecipient(
            Either.getOrThrow(x25519PublicJwk(sender.agentCard.publicKey)),
          )
          .setKeyManagementParameters(sharedEphemeralKey)
          .addRecipient(
            Either.getOrThrow(x25519PublicJwk(peer.agentCard.publicKey)),
          )
          .setKeyManagementParameters(sharedEphemeralKey)
          .encrypt(),
      catch: () => new Error("shared-key sealing failed"),
    });
    return yield* encodeCanonicalJson({
      ...representation,
      recipients: representation.recipients.map((recipient) => ({
        encrypted_key: recipient.encrypted_key,
      })),
    });
  });

/**
 * Carries a signed message through its wire representation and verifies it
 * as a recipient does.
 *
 * @param signedMessage Message as the sender produced it.
 * @param senderCard Sender's verified AgentCard.
 * @returns The message as a recipient verifies it.
 */
const receive = (
  signedMessage: VerifiedSignedMessage,
  senderCard: VerifiedAgentCard,
) =>
  Schema.encode(SignedMessage)(signedMessage).pipe(
    Effect.flatMap(Schema.decodeUnknown(SignedMessage)),
    Effect.flatMap((decoded) =>
      SignedMessage.verify({ signedMessage: decoded, agentCard: senderCard }),
    ),
  );

it.each([1, 3, 32])(
  "opens a body sealed to %i recipients for every recipient, the sender included",
  (recipientCount) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(recipientCount);
        const sealed = yield* sealFrom(
          group.sender,
          group.recipients,
          plaintext,
        );
        const signedMessage = yield* signBody(
          group.sender,
          group.recipients,
          sealed,
        );

        const opened = yield* Effect.forEach(
          group.recipients,
          (member) => openAs(member, signedMessage),
          { concurrency: FIXTURE_CONCURRENCY },
        );

        expect(group.recipients).toHaveLength(recipientCount);
        expect(group.recipients).toContain(group.sender);
        expect(opened).toEqual(group.recipients.map(() => plaintext));
        expect(utf8Decoder.decode(sealed)).not.toContain(PLAINTEXT_TEXT);
      }),
    ),
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
);

/**
 * AgentId bytes whose spellings sort differently as text: byte 66 spells
 * `agt_QkJC…` and byte 67 spells `agt_Q0ND…`, so a text sort puts 67 first
 * while the canonical bytewise recipient order puts 66 first.
 */
const TEXT_ORDER_INVERTING_BYTES = [66, 67];

/**
 * Seals from `sender` with the recipient cards in the order given, signs to
 * the same recipients, and checks that every recipient opens the plaintext.
 *
 * @param sender Sender of the SignedMessage.
 * @param recipients Recipients in the order the sender lists their cards.
 * @returns Completion once every recipient opens.
 */
const expectEveryListedRecipientOpens = (
  sender: Member,
  recipients: readonly Member[],
) =>
  Effect.gen(function* () {
    const sealed = yield* sealFrom(sender, recipients, plaintext);
    const signedMessage = yield* signBody(sender, recipients, sealed);

    const opened = yield* Effect.forEach(
      recipients,
      (member) => openAs(member, signedMessage),
      { concurrency: FIXTURE_CONCURRENCY },
    );

    expect(opened).toEqual(recipients.map(() => plaintext));
  });

/**
 * Runs `expectEveryListedRecipientOpens` over generated orders of the
 * recipient cards, starting with the reverse of the canonical order.
 *
 * @param sender Sender of the SignedMessage.
 * @param recipients Recipients in canonical order.
 * @returns The fast-check run, rejecting with the shrunk counterexample.
 */
const everyRecipientCardOrderOpens = (
  sender: Member,
  recipients: readonly Member[],
) =>
  fc.assert(
    fc.asyncProperty(
      fc.shuffledSubarray([...recipients], {
        minLength: recipients.length,
        maxLength: recipients.length,
      }),
      (order) =>
        Effect.runPromise(expectEveryListedRecipientOpens(sender, order)),
    ),
    { numRuns: 8, examples: [[[...recipients].reverse()]] },
  );

/**
 * Value: protects=seal orders entries by the canonical bytewise AgentId order
 * whatever order the caller lists the cards in; fails_when=seal keeps the
 * caller's order or sorts AgentIds as text; why_new=every other test lists
 * recipients already in canonical order, with AgentIds whose text and byte
 * orders agree; seam=none.
 */
it(
  "opens for every recipient whatever order the sender lists the recipient cards in",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(2);
        const textOrderInverting = yield* Effect.forEach(
          TEXT_ORDER_INVERTING_BYTES,
          (byte) => makeMember(group.registrySigningAuthority, byte),
          { concurrency: FIXTURE_CONCURRENCY },
        );

        yield* Effect.tryPromise({
          try: () =>
            everyRecipientCardOrderOpens(group.sender, [
              ...group.recipients,
              ...textOrderInverting,
            ]),
          catch: (counterexample) => counterexample,
        });
      }),
    ),
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
);

it(
  "opens every generated plaintext exactly and seals it to the reported length",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(3);
        yield* Effect.tryPromise({
          try: () => generatedPlaintextsRoundTrip(group),
          catch: (counterexample) => counterexample,
        });
      }),
    ),
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
);

it("refuses to open for an agent that is not a recipient", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(3);
      const sealed = yield* sealFrom(group.sender, group.recipients, plaintext);
      const signedMessage = yield* signBody(
        group.sender,
        group.recipients,
        sealed,
      );

      const outcome = yield* openAs(group.outsider, signedMessage).pipe(
        Effect.either,
      );

      expect(outcome).toStrictEqual(Either.left(new SealedBodyOpeningError()));
    }),
  ));

it.each([
  {
    part: "ciphertext",
    tamper: (body: RawSealedBody): RawSealedBody => ({
      ...body,
      ciphertext: flipFirstByte(body.ciphertext),
    }),
  },
  {
    part: "initialization vector",
    tamper: (body: RawSealedBody): RawSealedBody => ({
      ...body,
      iv: flipFirstByte(body.iv),
    }),
  },
  {
    part: "authentication tag",
    tamper: (body: RawSealedBody): RawSealedBody => ({
      ...body,
      tag: flipFirstByte(body.tag),
    }),
  },
  {
    part: "encrypted_key of the opening recipient",
    tamper: (body: RawSealedBody): RawSealedBody => ({
      ...body,
      recipients: body.recipients.map((recipient, index) =>
        index === 1
          ? {
              ...recipient,
              encrypted_key: flipFirstByte(recipient.encrypted_key),
            }
          : recipient,
      ),
    }),
  },
  /**
   * Value: protects=open refuses a noncanonical base64url spelling of the
   * same ciphertext bytes; fails_when=the ciphertext member accepts any
   * base64url text; why_new=the other ciphertext row changes the decoded
   * bytes, which content authentication refuses anyway; seam=none.
   */
  {
    part: "ciphertext spelling",
    tamper: (body: RawSealedBody): RawSealedBody => ({
      ...body,
      ciphertext: respellFinalCharacter(body.ciphertext),
    }),
  },
  /**
   * Value: protects=open refuses a noncanonical spelling of the same tag
   * bytes; fails_when=the tag member checks only its decoded length;
   * why_new=the other tag row changes the decoded bytes; seam=none.
   */
  {
    part: "authentication tag spelling",
    tamper: (body: RawSealedBody): RawSealedBody => ({
      ...body,
      tag: respellFinalCharacter(body.tag),
    }),
  },
  /**
   * Value: protects=open refuses a noncanonical spelling of the same wrapped
   * key bytes; fails_when=the encrypted_key member checks only its decoded
   * length; why_new=the other encrypted_key row changes the wrapped key, which
   * key unwrap refuses anyway; seam=none.
   */
  {
    part: "encrypted_key spelling of the opening recipient",
    tamper: (body: RawSealedBody): RawSealedBody => ({
      ...body,
      recipients: body.recipients.map((recipient, index) =>
        index === 1
          ? {
              ...recipient,
              encrypted_key: respellFinalCharacter(recipient.encrypted_key),
            }
          : recipient,
      ),
    }),
  },
  /**
   * Value: protects=a multi-recipient body opens only when every entry
   * carries its own ephemeral key; fails_when=the placement check inspects
   * only the opener's entry, which jose then opens; why_new=the existing
   * placement tests move every ephemeral key at once; seam=none.
   */
  {
    part: "ephemeral-key placement of another recipient's entry",
    tamper: (body: RawSealedBody): RawSealedBody => ({
      ...body,
      recipients: body.recipients.map((recipient, index) =>
        index === 0 ? { encrypted_key: recipient.encrypted_key } : recipient,
      ),
    }),
  },
])("refuses a sealed body with a tampered $part", ({ tamper }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(3);
      const sealed = yield* sealFrom(group.sender, group.recipients, plaintext);
      const tampered = yield* encodeCanonicalJson(
        tamper(readSealedBody(sealed)),
      );
      const signedMessage = yield* signBody(
        group.sender,
        group.recipients,
        tampered,
      );

      const outcome = yield* openAs(group.peer, signedMessage).pipe(
        Effect.either,
      );

      expect(outcome).toStrictEqual(Either.left(new SealedBodyOpeningError()));
    }),
  ),
);

it("refuses a body whose protected-header sender was rewritten to the re-signing member", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(3);
      const sealed = yield* sealFrom(group.sender, group.recipients, plaintext);
      const body = readSealedBody(sealed);
      const forged = yield* encodeCanonicalJson({
        ...body,
        protected: writeProtectedHeader({
          ...readProtectedHeader(body),
          [SENDER_HEADER]: group.peer.agentCard.agentId,
        }),
      });
      const signedMessage = yield* signBody(
        group.peer,
        group.recipients,
        forged,
      );

      const outcome = yield* openAs(group.sender, signedMessage).pipe(
        Effect.either,
      );

      expect(outcome).toStrictEqual(Either.left(new SealedBodyOpeningError()));
    }),
  ));

it("refuses an unchanged sealed body re-signed by another member", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(3);
      const sealed = yield* sealFrom(group.sender, group.recipients, plaintext);
      const signedMessage = yield* signBody(
        group.peer,
        group.recipients,
        sealed,
      );

      const outcome = yield* openAs(group.sender, signedMessage).pipe(
        Effect.either,
      );

      expect(outcome).toStrictEqual(Either.left(new SealedBodyOpeningError()));
    }),
  ));

it("refuses the recipients whose entries the sender moved out of canonical order", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(3);
      const sealed = yield* sealFrom(group.sender, group.recipients, plaintext);
      const body = readSealedBody(sealed);
      const firstTwoSwapped = yield* encodeCanonicalJson({
        ...body,
        recipients: [
          ...body.recipients.slice(1, 2),
          ...body.recipients.slice(0, 1),
          ...body.recipients.slice(2),
        ],
      });
      const signedMessage = yield* signBody(
        group.sender,
        group.recipients,
        firstTwoSwapped,
      );

      const outcomes = yield* Effect.forEach(
        group.recipients,
        (member) => openAs(member, signedMessage).pipe(Effect.either),
        { concurrency: 1 },
      );

      expect(outcomes).toStrictEqual([
        Either.left(new SealedBodyOpeningError()),
        Either.left(new SealedBodyOpeningError()),
        Either.right(plaintext),
      ]);
    }),
  ));

it("refuses a body whose entry count differs from the SignedMessage recipient count", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(3);
      const sealed = yield* sealFrom(group.sender, group.recipients, plaintext);
      const signedMessage = yield* signBody(
        group.sender,
        group.recipients.slice(0, 2),
        sealed,
      );

      const outcome = yield* openAs(group.sender, signedMessage).pipe(
        Effect.either,
      );

      expect(outcome).toStrictEqual(Either.left(new SealedBodyOpeningError()));
    }),
  ));

it.each([
  {
    body: "a plaintext body",
    make: () => Effect.succeed(utf8Encoder.encode("plain outer body")),
  },
  {
    body: "an empty body",
    make: () => Effect.succeed(new Uint8Array()),
  },
  {
    body: "canonical JSON that is not a JWE",
    make: () => encodeCanonicalJson({ kind: "post", text: "hello" }),
  },
  {
    body: "a sealed body with an added aad member",
    make: (sealed: Uint8Array) =>
      encodeCanonicalJson({ ...readSealedBody(sealed), aad: "AAAA" }),
  },
  {
    body: "a sealed body in non-canonical JSON",
    make: (sealed: Uint8Array) =>
      Effect.succeed(
        utf8Encoder.encode(JSON.stringify(readSealedBody(sealed), null, 1)),
      ),
  },
])("refuses $body", ({ make }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(2);
      const sealed = yield* sealFrom(group.sender, group.recipients, plaintext);
      const signedMessage = yield* signBody(
        group.sender,
        group.recipients,
        yield* make(sealed),
      );

      const outcome = yield* openAs(group.peer, signedMessage).pipe(
        Effect.either,
      );

      expect(outcome).toStrictEqual(Either.left(new SealedBodyOpeningError()));
    }),
  ),
);

it("refuses a single-recipient body whose ephemeral key sits in the recipient header", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(2);
      const sealed = yield* sealFrom(group.sender, group.recipients, plaintext);
      const body = readSealedBody(sealed);
      const firstRecipientOnly = yield* encodeCanonicalJson({
        ...body,
        recipients: body.recipients.slice(0, 1),
      });
      const signedMessage = yield* signBody(
        group.sender,
        [group.sender],
        firstRecipientOnly,
      );

      const outcome = yield* openAs(group.sender, signedMessage).pipe(
        Effect.either,
      );

      expect(outcome).toStrictEqual(Either.left(new SealedBodyOpeningError()));
    }),
  ));

it("refuses a multi-recipient body that shares one ephemeral key through the protected header", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(2);
      const sharedEpk = yield* sealWithSharedEphemeralKey(
        group.sender,
        group.peer,
      );
      const signedMessage = yield* signBody(
        group.sender,
        group.recipients,
        sharedEpk,
      );

      const outcome = yield* openAs(group.peer, signedMessage).pipe(
        Effect.either,
      );

      expect(outcome).toStrictEqual(Either.left(new SealedBodyOpeningError()));
    }),
  ));

/**
 * Seals `plaintext` to the sender and peer as `SealedBody.seal` does, with
 * `addedMembers` appended to the protected header.
 *
 * @param sender Sender and first recipient.
 * @param peer Second recipient.
 * @param addedMembers Protected-header members beyond alg, enc, and sender.
 * @returns Canonical bytes of the General JWE.
 */
const sealWithProtectedMembers = (
  sender: Member,
  peer: Member,
  addedMembers: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const representation = yield* Effect.tryPromise({
      try: () =>
        new GeneralEncrypt(plaintext)
          .setProtectedHeader({
            alg: "ECDH-ES+A256KW",
            enc: "A256GCM",
            [SENDER_HEADER]: sender.agentCard.agentId,
            ...addedMembers,
          })
          .addRecipient(
            Either.getOrThrow(x25519PublicJwk(sender.agentCard.publicKey)),
          )
          .addRecipient(
            Either.getOrThrow(x25519PublicJwk(peer.agentCard.publicKey)),
          )
          .encrypt(),
      catch: () => new Error("hand sealing failed"),
    });
    return yield* encodeCanonicalJson(representation);
  });

interface ProtectedMembersCase {
  readonly added: string;
  readonly members: Readonly<Record<string, string>>;
  readonly result: string;
  readonly expected: Either.Either<Uint8Array, SealedBodyOpeningError>;
}

/**
 * Value: protects=open refuses a protected header with a member beyond alg,
 * enc, and sender, which jose itself opens; fails_when=the protected-header
 * Schema stops refusing excess members; why_new=the aad row of the body table
 * adds an outer member, and rewriting a sealed header fails content
 * authentication before header exactness is reached; seam=none.
 */
it.each<ProtectedMembersCase>([
  {
    added: "no member",
    members: {},
    result: "the plaintext",
    expected: Either.right(plaintext),
  },
  {
    added: "a content-type member",
    members: { cty: "text/plain" },
    result: "SealedBodyOpeningError",
    expected: Either.left(new SealedBodyOpeningError()),
  },
])(
  "returns $result for a hand-sealed body whose protected header adds $added",
  ({ members, expected }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(2);
        const sealed = yield* sealWithProtectedMembers(
          group.sender,
          group.peer,
          members,
        );
        const signedMessage = yield* signBody(
          group.sender,
          group.recipients,
          sealed,
        );

        const outcome = yield* openAs(group.peer, signedMessage).pipe(
          Effect.either,
        );

        expect(outcome).toStrictEqual(expected);
      }),
    ),
);

it("opens the same sealed bytes re-wrapped under a new MessageId", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(3);
      const sealed = yield* sealFrom(group.sender, group.recipients, plaintext);
      const first = yield* signBody(group.sender, group.recipients, sealed, 1);
      const retry = yield* signBody(group.sender, group.recipients, sealed, 2);
      const received = yield* Effect.forEach(
        [first, retry],
        (signedMessage) => receive(signedMessage, group.sender.agentCard),
        { concurrency: 1 },
      );

      expect(received.map((message) => message.messageId)).toEqual([
        first.messageId,
        retry.messageId,
      ]);
      expect(first.messageId).not.toBe(retry.messageId);
      expect(
        yield* Effect.forEach(
          received,
          (signedMessage) => openAs(group.peer, signedMessage),
          { concurrency: 1 },
        ),
      ).toEqual([plaintext, plaintext]);
    }),
  ));

it.each([
  { recipientCount: 1, plaintextBytes: 0, sealedBytes: 411 },
  { recipientCount: 1, plaintextBytes: 1000, sealedBytes: 1745 },
  { recipientCount: 2, plaintextBytes: 1, sealedBytes: 566 },
  { recipientCount: 3, plaintextBytes: 1000, sealedBytes: 2069 },
  { recipientCount: 32, plaintextBytes: 1000, sealedBytes: 7028 },
])(
  "seals $plaintextBytes plaintext bytes to $recipientCount recipients in $sealedBytes bytes",
  ({ recipientCount, plaintextBytes, sealedBytes }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(recipientCount);

        const sealed = yield* sealFrom(
          group.sender,
          group.recipients,
          new Uint8Array(plaintextBytes),
        );

        expect(sealed.byteLength).toBe(sealedBytes);
        expect(
          SealedBody.sealedByteLength({
            plaintextByteLength: plaintextBytes,
            recipientCount,
          }),
        ).toStrictEqual(Option.some(sealedBytes));
      }),
    ),
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
);

it(
  "seals the largest 32-recipient plaintext to exactly the SignedMessage body cap",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(32);
        const largest = yield* sealFrom(
          group.sender,
          group.recipients,
          new Uint8Array(LARGEST_32_RECIPIENT_PLAINTEXT_BYTES),
        );
        const oneMore = yield* sealFrom(
          group.sender,
          group.recipients,
          new Uint8Array(LARGEST_32_RECIPIENT_PLAINTEXT_BYTES + 1),
        );

        expect(SealedBody.maximumPlaintextByteLength(32)).toStrictEqual(
          Option.some(LARGEST_32_RECIPIENT_PLAINTEXT_BYTES),
        );
        expect(largest.byteLength).toBe(SIGNED_MESSAGE_BODY_CAP);
        expect(oneMore.byteLength).toBe(SIGNED_MESSAGE_BODY_CAP + 1);
        expect(
          (yield* signBody(group.sender, group.recipients, largest)).body
            .byteLength,
        ).toBe(SIGNED_MESSAGE_BODY_CAP);
        expect(
          yield* signBody(group.sender, group.recipients, oneMore).pipe(
            Effect.either,
          ),
        ).toStrictEqual(Either.left(new SignedMessageSigningError()));
      }),
    ),
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
);

/**
 * Value: protects=the reported largest plaintext seals within the body cap,
 * one more byte exceeds it, and the largest body signs and opens at 1, 2,
 * and 128 recipients; fails_when=open's recipient-entry bound or body
 * decoding refuses a body seal produces at the size or recipient limit;
 * why_new=no other test opens a body sealed to 128 recipients or a body at
 * the size limit; seam=none.
 */
it.each([1, 2, 128])(
  "seals and opens the reported largest plaintext for %i recipients within the body cap, and one more byte exceeds it",
  (recipientCount) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(recipientCount);
        const largestPlaintextBytes = Option.getOrThrow(
          SealedBody.maximumPlaintextByteLength(recipientCount),
        );

        const largest = yield* sealFrom(
          group.sender,
          group.recipients,
          new Uint8Array(largestPlaintextBytes),
        );
        const oneMore = yield* sealFrom(
          group.sender,
          group.recipients,
          new Uint8Array(largestPlaintextBytes + 1),
        );
        const signedMessage = yield* signBody(
          group.sender,
          group.recipients,
          largest,
        );

        expect((yield* openAs(group.sender, signedMessage)).byteLength).toBe(
          largestPlaintextBytes,
        );
        expect(largest.byteLength).toBeLessThanOrEqual(SIGNED_MESSAGE_BODY_CAP);
        expect(oneMore.byteLength).toBeGreaterThan(SIGNED_MESSAGE_BODY_CAP);
        expect(
          SealedBody.sealedByteLength({
            plaintextByteLength: largestPlaintextBytes,
            recipientCount,
          }),
        ).toStrictEqual(Option.some(largest.byteLength));
      }),
    ),
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
);

it.each([
  { plaintextByteLength: 0, recipientCount: 0 },
  { plaintextByteLength: 0, recipientCount: 129 },
  { plaintextByteLength: 0, recipientCount: 1.5 },
  { plaintextByteLength: -1, recipientCount: 1 },
  { plaintextByteLength: 0.5, recipientCount: 1 },
  { plaintextByteLength: Number.MAX_SAFE_INTEGER, recipientCount: 1 },
])(
  "reports no sealed length for $plaintextByteLength plaintext bytes to $recipientCount recipients",
  (input) => {
    expect(SealedBody.sealedByteLength(input)).toStrictEqual(Option.none());
  },
);

it.each([0, 129, 2.5])(
  "reports no largest plaintext for %d recipients",
  (recipientCount) => {
    expect(SealedBody.maximumPlaintextByteLength(recipientCount)).toStrictEqual(
      Option.none(),
    );
  },
);

it(
  "refuses to seal to no recipients, a repeated recipient, or more than 128 recipients",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(129);

        const outcomes = yield* Effect.forEach(
          [[], [group.sender, group.sender], group.recipients],
          (recipients) =>
            sealFrom(group.sender, recipients, plaintext).pipe(Effect.either),
          { concurrency: 1 },
        );

        expect(outcomes).toStrictEqual([
          Either.left(new SealedBodySealingError()),
          Either.left(new SealedBodySealingError()),
          Either.left(new SealedBodySealingError()),
        ]);
      }),
    ),
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
);

it("refuses to seal to an AgentCard key that is not an Ed25519 curve point", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* makeGroup(1);
      const offCurveCard = yield* issueCard(
        group.registrySigningAuthority,
        9,
        Schema.decodeUnknownSync(Ed25519PublicKey)({
          crv: "Ed25519",
          kty: "OKP",
          x: "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }),
      );

      const outcome = yield* SealedBody.seal({
        senderAgentId: group.sender.agentCard.agentId,
        recipientAgentCards: [group.sender.agentCard, offCurveCard],
        plaintext,
      }).pipe(Effect.either);

      expect(outcome).toStrictEqual(Either.left(new SealedBodySealingError()));
    }),
  ));
