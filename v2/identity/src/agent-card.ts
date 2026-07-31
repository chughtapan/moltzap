import { generalVerify, GeneralSign, importJWK } from "jose";
import { createHash } from "node:crypto";
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
import {
  AgentSigningAuthority,
  agentSigningPrivateKey,
  Ed25519PublicKey,
  ed25519PublicKeyThumbprintUri,
  hasCanonicalEd25519SignatureEncoding,
  type Ed25519PublicKey as Ed25519PublicKeyValue,
} from "./agent-key.js";
import { decodeCanonicalJson, encodeCanonicalJson } from "./canonical-json.js";
import {
  AgentId,
  AgentName,
  PrincipalId,
  canonicalIdentifier,
  type AgentId as AgentIdValue,
  type AgentName as AgentNameValue,
  type PrincipalId as PrincipalIdValue,
} from "./identifiers.js";
import { MOLTZAP_VERSION } from "./version.js";

const DIGEST_BYTE_LENGTH = 32;
const WHOLE_SECOND_UTC =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/;
const AGENT_CARD_TYPE = "application/vnd.moltzap.agent-card+jws";
const ED25519_SIGNATURE_BYTES = 64;

const isWholeSecondUtc = (value: string): boolean => {
  if (typeof value !== "string") {
    return false;
  }
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) {
    return false;
  }
  // eslint-disable-next-line sonarjs/null-dereference -- The explicit runtime guard above establishes the string consumed by this Schema predicate.
  const wholeSecondValue = `${value.slice(0, -1)}.000Z`;
  return new Date(epochMilliseconds).toISOString() === wholeSecondValue;
};

/** Digest binding a message to one complete immutable AgentCard. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the public domain name they decode.
export const AgentCardDigest = canonicalIdentifier(
  "AgentCardDigest",
  "acd_",
  DIGEST_BYTE_LENGTH,
);
/** Validated nominal value decoded by AgentCardDigest. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one boundary model.
export type AgentCardDigest = typeof AgentCardDigest.Type;

/** Whole-second UTC issuance evidence carried by an AgentCard. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the package-owned domain name they decode.
export const AgentCardIssuedAt = Schema.String.pipe(
  Schema.pattern(WHOLE_SECOND_UTC),
  Schema.filter(isWholeSecondUtc, {
    identifier: "AgentCardIssuedAt",
    description: "AgentCard issuance time in whole-second UTC",
  }),
  Schema.brand("AgentCardIssuedAt"),
  Schema.annotations({
    identifier: "AgentCardIssuedAt",
    description: "AgentCard issuance time in whole-second UTC",
  }),
);
/** Validated nominal value decoded by AgentCardIssuedAt. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one package boundary model.
export type AgentCardIssuedAt = typeof AgentCardIssuedAt.Type;

const hasCanonicalBase64UrlByteLength = (
  value: string,
  expectedByteLength?: number,
): boolean =>
  Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => false,
    onRight: (bytes) =>
      Encoding.encodeBase64Url(bytes) === value &&
      (expectedByteLength === undefined ||
        bytes.byteLength === expectedByteLength),
  });

const canonicalBase64Url = Schema.String.pipe(
  Schema.filter((value) => hasCanonicalBase64UrlByteLength(value)),
);

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({
    parseOptions: {
      exact: true,
      onExcessProperty: "error",
    },
  });

const jwsSignatureRepresentation = exactStruct({
  protected: canonicalBase64Url,
  signature: Schema.String.pipe(
    Schema.filter((value) =>
      Either.match(Encoding.decodeBase64Url(value), {
        onLeft: () => false,
        onRight: (bytes) =>
          Encoding.encodeBase64Url(bytes) === value &&
          bytes.byteLength === ED25519_SIGNATURE_BYTES &&
          hasCanonicalEd25519SignatureEncoding(bytes),
      }),
    ),
  ),
});

const generalJwsRepresentation = exactStruct({
  payload: canonicalBase64Url,
  signatures: Schema.Tuple(jwsSignatureRepresentation),
});

type AgentCardRepresentation = typeof generalJwsRepresentation.Type;

const protectedHeader = exactStruct({
  alg: Schema.Literal("Ed25519"),
  kid: Schema.String,
  typ: Schema.Literal(AGENT_CARD_TYPE),
});

const payload = exactStruct({
  kind: Schema.Literal("agentCard"),
  moltzapVersion: Schema.Literal(MOLTZAP_VERSION),
  agentId: AgentId,
  principalId: PrincipalId,
  agentName: AgentName,
  publicKey: Ed25519PublicKey,
  issuedAt: AgentCardIssuedAt,
});

/** Immutable public identity fields carried by an AgentCard. */
export interface AgentCard {
  readonly agentId: AgentIdValue;
  readonly principalId: PrincipalIdValue;
  readonly agentName: AgentNameValue;
  readonly publicKey: Ed25519PublicKeyValue;
  readonly issuedAt: string;
}

interface AgentCardState {
  readonly representation: AgentCardRepresentation;
  readonly protectedHeader: typeof protectedHeader.Type;
}

const cardState = new WeakMap<object, AgentCardState>();
const verifiedCards = new WeakSet();

const hasAgentCardState = (value: unknown): value is AgentCard =>
  typeof value === "object" &&
  value !== null &&
  Object.isFrozen(value) &&
  cardState.has(value);

const agentCardView = Schema.declare(hasAgentCardState, {
  identifier: "AgentCardView",
});

const parseIssue = (
  ast: SchemaAST.Transformation,
  actual: unknown,
): ParseResult.ParseIssue =>
  new ParseResult.Type(ast, actual, "Expected an exact AgentCard");

const decodeBase64Url = (
  value: string,
  ast: SchemaAST.Transformation,
): Effect.Effect<Uint8Array, ParseResult.ParseIssue> =>
  Encoding.decodeBase64Url(value).pipe(
    Effect.mapError(() => parseIssue(ast, value)),
  );

const snapshotRepresentation = (
  representation: AgentCardRepresentation,
): AgentCardRepresentation =>
  Object.freeze({
    payload: representation.payload,
    signatures: Object.freeze([
      Object.freeze({
        protected: representation.signatures[0].protected,
        signature: representation.signatures[0].signature,
      }),
    ] as const),
  });

const decodeRepresentation = (
  representation: AgentCardRepresentation,
  ast: SchemaAST.Transformation,
): Effect.Effect<AgentCard, ParseResult.ParseIssue> =>
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
    const publicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
      Object.freeze({
        crv: decodedPayload.publicKey.crv,
        kty: decodedPayload.publicKey.kty,
        x: decodedPayload.publicKey.x,
      }),
    ).pipe(Effect.mapError(() => parseIssue(ast, representation)));
    const card = Object.freeze({
      agentId: decodedPayload.agentId,
      principalId: decodedPayload.principalId,
      agentName: decodedPayload.agentName,
      publicKey,
      issuedAt: decodedPayload.issuedAt,
    });
    const retained = snapshotRepresentation(representation);
    yield* encodeCanonicalJson(retained).pipe(
      Effect.mapError(() => parseIssue(ast, representation)),
    );
    cardState.set(card, {
      representation: retained,
      protectedHeader: Object.freeze({ ...decodedHeader }),
    });
    return card;
  });

const encodeView = (
  card: AgentCard,
  ast: SchemaAST.Transformation,
): Effect.Effect<AgentCardRepresentation, ParseResult.ParseIssue> => {
  const state = cardState.get(card);
  return state === undefined
    ? Effect.fail(parseIssue(ast, card))
    : Effect.succeed(state.representation);
};

const agentCardSchema = Schema.transformOrFail(
  generalJwsRepresentation,
  agentCardView,
  {
    strict: true,
    decode: (representation, ...[, ast]) =>
      decodeRepresentation(representation, ast),
    encode: (card, ...[, ast]) => encodeView(card, ast),
  },
).annotations({
  identifier: "AgentCard",
  parseOptions: {
    exact: true,
    onExcessProperty: "error",
  },
});

/** AgentCard verified against a deployment-pinned Registry signer. */
export type VerifiedAgentCard = AgentCard & Brand.Brand<"VerifiedAgentCard">;

const brandVerifiedAgentCard = Brand.nominal<VerifiedAgentCard>();

/** Private no-serialization RPC witness for a verified card. */
export const verifiedAgentCardSchema = Schema.declare(
  (value: unknown): value is VerifiedAgentCard =>
    typeof value === "object" &&
    value !== null &&
    cardState.has(value) &&
    verifiedCards.has(value),
  { identifier: "VerifiedAgentCard" },
);

/** A parsed AgentCard does not verify against the pinned Registry signer. */
export class AgentCardVerificationError extends Data.TaggedError(
  "AgentCardVerificationError",
) {}

const verificationFailure = (): AgentCardVerificationError =>
  new AgentCardVerificationError();

interface IssueAgentCardInput {
  readonly agentId: AgentIdValue;
  readonly principalId: PrincipalIdValue;
  readonly agentName: AgentNameValue;
  readonly publicKey: Ed25519PublicKeyValue;
  readonly issuedAt: AgentCardIssuedAt;
  readonly registrySigningAuthority: AgentSigningAuthority;
}

const parseAgentCard = (
  representation: unknown,
): Effect.Effect<AgentCard, AgentCardVerificationError> =>
  Schema.decodeUnknown(agentCardSchema)(representation, {
    exact: true,
    onExcessProperty: "error",
  }).pipe(Effect.mapError(verificationFailure));

const verifyAgentCard = (input: {
  readonly agentCard: AgentCard;
  readonly registrySignerPublicKey: Ed25519PublicKeyValue;
}): Effect.Effect<VerifiedAgentCard, AgentCardVerificationError> =>
  Effect.gen(function* () {
    const state = cardState.get(input.agentCard);
    if (state === undefined) {
      return yield* new AgentCardVerificationError();
    }
    const expectedKid = yield* ed25519PublicKeyThumbprintUri(
      input.registrySignerPublicKey,
    ).pipe(Effect.mapError(verificationFailure));
    if (
      state.protectedHeader.alg !== "Ed25519" ||
      state.protectedHeader.typ !== AGENT_CARD_TYPE ||
      state.protectedHeader.kid !== expectedKid
    ) {
      return yield* new AgentCardVerificationError();
    }
    const key = yield* Effect.tryPromise({
      try: () => importJWK(input.registrySignerPublicKey, "Ed25519"),
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
          {
            algorithms: ["Ed25519"],
          },
        );
      },
      catch: verificationFailure,
    });
    verifiedCards.add(input.agentCard);
    return brandVerifiedAgentCard(input.agentCard);
  });

/**
 * Issues one exact AgentCard for Registry storage.
 *
 * @param input Complete identity fields and Registry signing authority.
 * @returns A Registry-verified immutable AgentCard.
 */
export const issueAgentCard = (
  input: IssueAgentCardInput,
): Effect.Effect<VerifiedAgentCard, AgentCardVerificationError> =>
  Effect.gen(function* () {
    const payloadBytes = yield* encodeCanonicalJson({
      kind: "agentCard",
      moltzapVersion: MOLTZAP_VERSION,
      agentId: input.agentId,
      principalId: input.principalId,
      agentName: input.agentName,
      publicKey: input.publicKey,
      issuedAt: input.issuedAt,
    }).pipe(Effect.mapError(verificationFailure));
    const kid = yield* ed25519PublicKeyThumbprintUri(
      AgentSigningAuthority.publicKey(input.registrySigningAuthority),
    ).pipe(Effect.mapError(verificationFailure));
    const representation = yield* Effect.tryPromise({
      try: () =>
        new GeneralSign(payloadBytes)
          .addSignature(agentSigningPrivateKey(input.registrySigningAuthority))
          .setProtectedHeader({
            alg: "Ed25519",
            kid,
            typ: AGENT_CARD_TYPE,
          })
          .sign(),
      catch: verificationFailure,
    });
    const card = yield* parseAgentCard(representation);
    return yield* verifyAgentCard({
      agentCard: card,
      registrySignerPublicKey: AgentSigningAuthority.publicKey(
        input.registrySigningAuthority,
      ),
    });
  }).pipe(Effect.withSpan("issueAgentCard"));

/**
 * JCS representation bytes retained by a parsed AgentCard.
 *
 * @param agentCard Parsed AgentCard whose retained bytes are requested.
 * @returns The complete canonical General JWS bytes.
 */
export const encodeAgentCard = (
  agentCard: AgentCard,
): Effect.Effect<Uint8Array, AgentCardVerificationError> => {
  const state = cardState.get(agentCard);
  return state === undefined
    ? Effect.fail(new AgentCardVerificationError())
    : encodeCanonicalJson(state.representation).pipe(
        Effect.mapError(verificationFailure),
      );
};

/**
 * Identity-owned digest over the complete retained AgentCard JWS.
 *
 * @param agentCard Parsed AgentCard to digest.
 * @returns The refined SHA-256 AgentCard digest.
 */
export const digestAgentCard = (
  agentCard: AgentCard,
): Effect.Effect<AgentCardDigest, AgentCardVerificationError> =>
  Effect.gen(function* () {
    const bytes = yield* encodeAgentCard(agentCard);
    const digest = yield* Effect.try({
      try: () => createHash("sha256").update(bytes).digest(),
      catch: () => new AgentCardVerificationError(),
    });
    return yield* Schema.decodeUnknown(AgentCardDigest)(
      `acd_${Encoding.encodeBase64Url(digest)}`,
    ).pipe(Effect.mapError(verificationFailure));
  }).pipe(Effect.withSpan("digestAgentCard"));

/* eslint-disable @typescript-eslint/no-redeclare, @typescript-eslint/naming-convention, agent-code-guard/as-unknown-as, agent-code-guard/require-assertion-rationale --
 * The accepted same-name Schema/type API retains the exact private General JWS AST while erasing only its encoded TypeScript type.
 */
/** Verifies immutable Registry attestation without exposing JOSE mechanics. */
export const AgentCard = Object.assign(agentCardSchema, {
  verify: verifyAgentCard,
}) as unknown as Schema.Schema<AgentCard, unknown> &
  Readonly<{
    readonly verify: typeof verifyAgentCard;
  }>;
/* eslint-enable @typescript-eslint/no-redeclare, @typescript-eslint/naming-convention, agent-code-guard/as-unknown-as, agent-code-guard/require-assertion-rationale --
 * The accepted same-name Schema/type API retains the exact private General JWS AST while erasing only its encoded TypeScript type.
 */
