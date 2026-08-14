/** @file Canonical end-to-end signed message representation, signing, and verification. */

import {
  Brand,
  Data,
  Effect,
  Either,
  Encoding,
  ParseResult,
  Schema,
  type SchemaAST,
} from "effect";
import { GeneralSign, generalVerify, importJWK } from "jose";
import {
  AgentCardDigest,
  type AgentCardDigest as AgentCardDigestValue,
  digestAgentCard,
  type VerifiedAgentCard,
} from "./agent-card.js";
import {
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  agentSigningPrivateKey,
  ed25519PublicKeyThumbprintUri,
  hasCanonicalEd25519SignatureEncoding,
} from "./agent-key.js";
import { decodeCanonicalJson, encodeCanonicalJson } from "./canonical-json.js";
import {
  AgentId,
  type AgentId as AgentIdValue,
  canonicalIdentifier,
} from "./identifiers.js";
import { MOLTZAP_VERSION } from "./version.js";

/** Sender-scoped identity of one attributed message. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the public domain name they decode.
export const MessageId = canonicalIdentifier("MessageId", "msg_", 16);
/** Validated nominal value decoded by MessageId. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one boundary model.
export type MessageId = typeof MessageId.Type;

const SIGNED_MESSAGE_TYPE = "application/vnd.moltzap.signed-message+jws";
const MAXIMUM_BODY_BYTES = 262_144;
const MAXIMUM_RECIPIENTS = 128;
const MAXIMUM_ENCODED_BYTES = 471_671;
const ED25519_SIGNATURE_BYTES = 64;

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

const signatureRepresentation = exactStruct({
  protected: canonicalBase64Url,
  signature: Schema.String.pipe(
    Schema.filter((value) => {
      const bytes = decodeCanonicalBase64Url(value);
      return (
        bytes?.byteLength === ED25519_SIGNATURE_BYTES &&
        hasCanonicalEd25519SignatureEncoding(bytes)
      );
    }),
  ),
});

const generalJwsRepresentation = exactStruct({
  payload: canonicalBase64Url,
  signatures: Schema.Tuple(signatureRepresentation),
});

type SignedMessageRepresentation = typeof generalJwsRepresentation.Type;

const protectedHeader = exactStruct({
  alg: Schema.Literal("Ed25519"),
  kid: Schema.String,
  typ: Schema.Literal(SIGNED_MESSAGE_TYPE),
});

const compareAgentIds = (left: AgentIdValue, right: AgentIdValue): number => {
  const leftBytes = decodeCanonicalBase64Url(left.slice(4));
  const rightBytes = decodeCanonicalBase64Url(right.slice(4));
  if (leftBytes === undefined || rightBytes === undefined) {
    return 0;
  }
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) {
      return 0;
    }
    const difference = leftByte - rightByte;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.byteLength - rightBytes.byteLength;
};

const recipientsAreCanonical = (
  recipientAgentIds: readonly AgentIdValue[],
): boolean => {
  for (let index = 1; index < recipientAgentIds.length; index += 1) {
    const previous = recipientAgentIds[index - 1];
    const current = recipientAgentIds[index];
    if (previous === undefined || current === undefined) {
      return false;
    }
    if (compareAgentIds(previous, current) >= 0) {
      return false;
    }
  }
  return true;
};

const recipientAgentIds = Schema.Array(AgentId).pipe(
  Schema.minItems(1),
  Schema.maxItems(MAXIMUM_RECIPIENTS),
  Schema.filter(recipientsAreCanonical),
);

const opaqueBody = Schema.String.pipe(
  Schema.filter((value) => {
    const bytes = decodeCanonicalBase64Url(value);
    return bytes !== undefined && bytes.byteLength <= MAXIMUM_BODY_BYTES;
  }),
);

const payload = exactStruct({
  kind: Schema.Literal("signedMessage"),
  moltzapVersion: Schema.Literal(MOLTZAP_VERSION),
  senderAgentId: AgentId,
  agentCardDigest: AgentCardDigest,
  recipientAgentIds,
  messageId: MessageId,
  body: opaqueBody,
});

/** Immutable attributed-message fields exposed to Router consumers. */
export interface SignedMessage {
  readonly senderAgentId: AgentIdValue;
  readonly agentCardDigest: AgentCardDigestValue;
  readonly recipientAgentIds: readonly AgentIdValue[];
  readonly messageId: MessageId;
  readonly body: Uint8Array;
}

interface SignedMessageState {
  readonly representation: SignedMessageRepresentation;
  readonly protectedHeader: typeof protectedHeader.Type;
  readonly body: Uint8Array;
  readonly encodedByteLength: number;
}

const messageState = new WeakMap<object, SignedMessageState>();

const hasSignedMessageState = (value: unknown): value is SignedMessage =>
  typeof value === "object" &&
  value !== null &&
  Object.isFrozen(value) &&
  messageState.has(value);

const signedMessageView = Schema.declare(hasSignedMessageState, {
  identifier: "SignedMessageView",
});

const parseIssue = (
  ast: SchemaAST.Transformation,
  actual: unknown,
): ParseResult.ParseIssue =>
  new ParseResult.Type(ast, actual, "Expected an exact SignedMessage");

const decodeBase64Url = (
  value: string,
  ast: SchemaAST.Transformation,
): Effect.Effect<Uint8Array, ParseResult.ParseIssue> => {
  const bytes = decodeCanonicalBase64Url(value);
  return bytes === undefined
    ? Effect.fail(parseIssue(ast, value))
    : Effect.succeed(bytes);
};

const snapshotRepresentation = (
  representation: SignedMessageRepresentation,
): SignedMessageRepresentation =>
  Object.freeze({
    payload: representation.payload,
    signatures: Object.freeze([
      Object.freeze({
        protected: representation.signatures[0].protected,
        signature: representation.signatures[0].signature,
      }),
    ] as const),
  });

const makeView = (
  decodedPayload: typeof payload.Type,
  body: Uint8Array,
): SignedMessage => {
  const recipients = Object.freeze([...decodedPayload.recipientAgentIds]);
  const bodySnapshot = Uint8Array.from(body);
  const view: SignedMessage = {
    senderAgentId: decodedPayload.senderAgentId,
    agentCardDigest: decodedPayload.agentCardDigest,
    recipientAgentIds: recipients,
    messageId: decodedPayload.messageId,
    get body() {
      return Uint8Array.from(bodySnapshot);
    },
  };
  return Object.freeze(view);
};

const decodeRepresentation = (
  representation: SignedMessageRepresentation,
  ast: SchemaAST.Transformation,
): Effect.Effect<SignedMessage, ParseResult.ParseIssue> =>
  Effect.gen(function* () {
    const payloadBytes = yield* decodeBase64Url(representation.payload, ast);
    const headerBytes = yield* decodeBase64Url(
      representation.signatures[0].protected,
      ast,
    );
    const decodedPayload = yield* decodeCanonicalJson(
      payload,
      payloadBytes,
    ).pipe(Effect.mapError(() => parseIssue(ast, representation)));
    const decodedHeader = yield* decodeCanonicalJson(
      protectedHeader,
      headerBytes,
    ).pipe(Effect.mapError(() => parseIssue(ast, representation)));
    const body = yield* decodeBase64Url(decodedPayload.body, ast);
    const retained = snapshotRepresentation(representation);
    const encoded = yield* encodeCanonicalJson(retained).pipe(
      Effect.mapError(() => parseIssue(ast, representation)),
    );
    if (encoded.byteLength > MAXIMUM_ENCODED_BYTES) {
      return yield* Effect.fail(parseIssue(ast, representation));
    }
    const view = makeView(decodedPayload, body);
    messageState.set(view, {
      representation: retained,
      protectedHeader: Object.freeze({ ...decodedHeader }),
      body: Uint8Array.from(body),
      encodedByteLength: encoded.byteLength,
    });
    return view;
  });

const encodeView = (
  message: SignedMessage,
  ast: SchemaAST.Transformation,
): Effect.Effect<SignedMessageRepresentation, ParseResult.ParseIssue> => {
  const state = messageState.get(message);
  return state === undefined
    ? Effect.fail(parseIssue(ast, message))
    : Effect.succeed(state.representation);
};

const signedMessageSchema = Schema.transformOrFail(
  generalJwsRepresentation,
  signedMessageView,
  {
    strict: true,
    decode: (representation, ...[, ast]) =>
      decodeRepresentation(representation, ast),
    encode: (message, ...[, ast]) => encodeView(message, ast),
  },
).annotations({
  identifier: "SignedMessage",
  parseOptions: {
    exact: true,
    onExcessProperty: "error",
  },
});

/** SignedMessage whose sender attribution and signature are verified. */
export type VerifiedSignedMessage = SignedMessage &
  Brand.Brand<"VerifiedSignedMessage">;

const brandVerifiedSignedMessage = Brand.nominal<VerifiedSignedMessage>();

/** A message cannot be signed under the supplied immutable identity. */
export class SignedMessageSigningError extends Data.TaggedError(
  "SignedMessageSigningError",
) {}

/** A SignedMessage does not bind to the supplied verified AgentCard. */
export class SignedMessageVerificationError extends Data.TaggedError(
  "SignedMessageVerificationError",
) {}

const signingFailure = (): SignedMessageSigningError =>
  new SignedMessageSigningError();

const verificationFailure = (): SignedMessageVerificationError =>
  new SignedMessageVerificationError();

const parseSignedMessage = (
  representation: unknown,
): Effect.Effect<SignedMessage, SignedMessageSigningError> =>
  Schema.decodeUnknown(signedMessageSchema)(representation, {
    exact: true,
    onExcessProperty: "error",
  }).pipe(Effect.mapError(signingFailure));

interface SignInput {
  readonly agentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthorityValue;
  readonly recipientAgentIds: ReadonlySet<AgentIdValue>;
  readonly messageId: MessageId;
  readonly body: Uint8Array;
}

const snapshotRecipients = (recipientAgentIds: ReadonlySet<AgentIdValue>) =>
  Effect.gen(function* () {
    const recipients = yield* Effect.try({
      try: () => Array.from(recipientAgentIds),
      catch: signingFailure,
    });
    recipients.sort(compareAgentIds);
    if (
      recipients.length === 0 ||
      recipients.length > MAXIMUM_RECIPIENTS ||
      !recipientsAreCanonical(recipients)
    ) {
      return yield* new SignedMessageSigningError();
    }
    return recipients;
  });

const snapshotBody = (candidate: Uint8Array) =>
  Effect.gen(function* () {
    const body = yield* Effect.try({
      try: () => Uint8Array.from(candidate),
      catch: signingFailure,
    });
    if (body.byteLength > MAXIMUM_BODY_BYTES) {
      return yield* new SignedMessageSigningError();
    }
    return body;
  });

const prepareSigningMaterial = (input: SignInput) =>
  Effect.gen(function* () {
    if (
      AgentSigningAuthority.publicKey(input.signingAuthority).x !==
      input.agentCard.publicKey.x
    ) {
      return yield* new SignedMessageSigningError();
    }
    const recipients = yield* snapshotRecipients(input.recipientAgentIds);
    const body = yield* snapshotBody(input.body);
    const agentCardDigest = yield* digestAgentCard(input.agentCard).pipe(
      Effect.mapError(signingFailure),
    );
    const kid = yield* ed25519PublicKeyThumbprintUri(
      input.agentCard.publicKey,
    ).pipe(Effect.mapError(signingFailure));
    const payloadBytes = yield* encodeCanonicalJson({
      kind: "signedMessage",
      moltzapVersion: MOLTZAP_VERSION,
      senderAgentId: input.agentCard.agentId,
      agentCardDigest,
      recipientAgentIds: recipients,
      messageId: input.messageId,
      body: Encoding.encodeBase64Url(body),
    }).pipe(Effect.mapError(signingFailure));
    return { kid, payloadBytes };
  });

const sign = (
  input: SignInput,
): Effect.Effect<VerifiedSignedMessage, SignedMessageSigningError> =>
  Effect.gen(function* () {
    const { kid, payloadBytes } = yield* prepareSigningMaterial(input);
    const representation = yield* Effect.tryPromise({
      try: () =>
        new GeneralSign(payloadBytes)
          .addSignature(agentSigningPrivateKey(input.signingAuthority))
          .setProtectedHeader({
            alg: "Ed25519",
            kid,
            typ: SIGNED_MESSAGE_TYPE,
          })
          .sign(),
      catch: signingFailure,
    });
    const signedMessage = yield* parseSignedMessage(representation);
    return brandVerifiedSignedMessage(signedMessage);
  });

interface VerifyInput {
  readonly signedMessage: SignedMessage;
  readonly agentCard: VerifiedAgentCard;
}

const verify = (
  input: VerifyInput,
): Effect.Effect<VerifiedSignedMessage, SignedMessageVerificationError> =>
  Effect.gen(function* () {
    const state = messageState.get(input.signedMessage);
    if (state === undefined) {
      return yield* new SignedMessageVerificationError();
    }
    const expectedDigest = yield* digestAgentCard(input.agentCard).pipe(
      Effect.mapError(verificationFailure),
    );
    const expectedKid = yield* ed25519PublicKeyThumbprintUri(
      input.agentCard.publicKey,
    ).pipe(Effect.mapError(verificationFailure));
    const messageMatches =
      input.signedMessage.senderAgentId === input.agentCard.agentId &&
      input.signedMessage.agentCardDigest === expectedDigest;
    const headerMatches =
      state.protectedHeader.kid === expectedKid &&
      state.protectedHeader.alg === "Ed25519" &&
      state.protectedHeader.typ === SIGNED_MESSAGE_TYPE;
    if (!messageMatches || !headerMatches) {
      return yield* new SignedMessageVerificationError();
    }
    const key = yield* Effect.tryPromise({
      try: () => importJWK(input.agentCard.publicKey, "Ed25519"),
      catch: verificationFailure,
    });
    yield* Effect.tryPromise({
      try: () => {
        const signature = state.representation.signatures[0];
        return generalVerify(
          {
            payload: state.representation.payload,
            signatures: [
              {
                protected: signature.protected,
                signature: signature.signature,
              },
            ],
          },
          key,
          { algorithms: ["Ed25519"] },
        );
      },
      catch: verificationFailure,
    });
    return brandVerifiedSignedMessage(input.signedMessage);
  });

const encodedByteLength = (signedMessage: SignedMessage): number =>
  messageState.get(signedMessage)?.encodedByteLength ?? 0;

/* eslint-disable @typescript-eslint/no-redeclare, @typescript-eslint/naming-convention, agent-code-guard/require-assertion-rationale --
 * The accepted same-name Schema/type API retains the exact private General JWS AST while erasing only its encoded TypeScript type.
 */
/** Opaque attributed message operations and exact representation Schema. */
export const SignedMessage = Object.assign(signedMessageSchema, {
  sign,
  verify,
  encodedByteLength,
  maximumEncodedByteLength: MAXIMUM_ENCODED_BYTES,
}) as Schema.Schema<SignedMessage, unknown> &
  Readonly<{
    readonly sign: typeof sign;
    readonly verify: typeof verify;
    readonly encodedByteLength: typeof encodedByteLength;
    readonly maximumEncodedByteLength: number;
  }>;
/* eslint-enable @typescript-eslint/no-redeclare, @typescript-eslint/naming-convention, agent-code-guard/require-assertion-rationale --
 * The accepted same-name Schema/type API retains the exact private General JWS AST while erasing only its encoded TypeScript type.
 */
