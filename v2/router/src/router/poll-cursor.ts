import { type AgentId, AgentId as AgentIdSchema } from "@moltzap/v2-identity";
import { compactDecrypt, CompactEncrypt } from "jose";
import canonicalize from "canonicalize";
import { Data, Effect, Encoding, Schema } from "effect";
import {
  PollCursor,
  type PollCursor as PollCursorValue,
  RouterInstanceId,
  type RouterInstanceId as RouterInstanceIdValue,
} from "./values.js";

/** Greatest private order representable in one cursor. */
export const maximumPrivateOrder = (1n << 128n) - 1n;

const protectedHeader = Object.freeze({
  alg: "dir" as const,
  enc: "A256GCM" as const,
  typ: "application/vnd.moltzap.poll-cursor+jwe" as const,
});
const protectedHeaderJson =
  '{"alg":"dir","enc":"A256GCM","typ":"application/vnd.moltzap.poll-cursor+jwe"}';
const encodedProtectedHeader = Encoding.encodeBase64Url(
  new TextEncoder().encode(protectedHeaderJson),
);
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

const orderText = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)$/),
  Schema.filter((value) => BigInt(value) <= maximumPrivateOrder),
);

const cursorPlaintext = Schema.Struct({
  agentId: AgentIdSchema,
  routerInstanceId: RouterInstanceId,
  lastScannedOrder: orderText,
}).annotations({
  parseOptions: {
    exact: true,
    onExcessProperty: "error",
  },
});

/** Cursor construction failed before a result could be returned. */
class PollCursorEncryptionError extends Data.TaggedError(
  "PollCursorEncryptionError",
) {}

/** A cursor does not authenticate for this caller and process. */
class PollCursorInvalidError extends Data.TaggedError(
  "PollCursorInvalidError",
) {}

/** Authenticated current-process cursor operations. */
export interface PollCursorCodec {
  readonly encrypt: (input: {
    readonly agentId: AgentId;
    readonly lastScannedOrder: bigint;
  }) => Effect.Effect<PollCursorValue, PollCursorEncryptionError>;
  readonly decrypt: (
    cursor: PollCursorValue,
    callerAgentId: AgentId,
  ) => Effect.Effect<bigint, PollCursorInvalidError>;
}

const canonicalPlaintext = (input: {
  readonly agentId: AgentId;
  readonly routerInstanceId: RouterInstanceIdValue;
  readonly lastScannedOrder: bigint;
}): string | undefined =>
  canonicalize({
    agentId: input.agentId,
    routerInstanceId: input.routerInstanceId,
    lastScannedOrder: input.lastScannedOrder.toString(10),
  });

const invalidCursor = () => new PollCursorInvalidError();

const headerIsExact = (header: Readonly<Record<string, unknown>>): boolean => {
  if (Reflect.ownKeys(header).length !== 3) {
    return false;
  }
  return (
    header.alg === protectedHeader.alg &&
    header.enc === protectedHeader.enc &&
    header.typ === protectedHeader.typ
  );
};

const encodePollCursor = (
  key: Uint8Array,
  routerInstanceId: RouterInstanceIdValue,
  agentId: AgentId,
  lastScannedOrder: bigint,
): Effect.Effect<PollCursorValue, PollCursorEncryptionError> =>
  Effect.gen(function* () {
    if (lastScannedOrder < 0n || lastScannedOrder > maximumPrivateOrder) {
      return yield* Effect.fail(new PollCursorEncryptionError());
    }
    const plaintext = canonicalPlaintext({
      agentId,
      routerInstanceId,
      lastScannedOrder,
    });
    if (plaintext === undefined) {
      return yield* Effect.fail(new PollCursorEncryptionError());
    }
    const compact = yield* Effect.tryPromise({
      try: () =>
        new CompactEncrypt(utf8Encoder.encode(plaintext))
          .setProtectedHeader(protectedHeader)
          .encrypt(key),
      catch: () => new PollCursorEncryptionError(),
    });
    return yield* Schema.decodeUnknown(PollCursor)(`plc_${compact}`).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new PollCursorEncryptionError()),
      ),
    );
  });

const plaintextIsCurrent = (input: {
  readonly canonical: string;
  readonly text: string;
  readonly agentId: AgentId;
  readonly callerAgentId: AgentId;
  readonly routerInstanceId: RouterInstanceIdValue;
  readonly currentRouterInstanceId: RouterInstanceIdValue;
}): boolean => {
  if (input.canonical !== input.text) {
    return false;
  }
  return (
    input.agentId === input.callerAgentId &&
    input.routerInstanceId === input.currentRouterInstanceId
  );
};

type CursorPlaintext = typeof cursorPlaintext.Type;

const decodeCursorPlaintext = (
  text: string,
): Effect.Effect<CursorPlaintext, PollCursorInvalidError> =>
  Schema.decodeUnknown(Schema.parseJson(cursorPlaintext))(text, {
    exact: true,
    onExcessProperty: "error",
  }).pipe(Effect.catchTag("ParseError", () => Effect.fail(invalidCursor())));

const decodePollCursor = (
  key: Uint8Array,
  routerInstanceId: RouterInstanceIdValue,
  cursor: PollCursorValue,
  callerAgentId: AgentId,
): Effect.Effect<bigint, PollCursorInvalidError> =>
  Effect.gen(function* () {
    const compact = cursor.slice(4);
    if (compact.split(".", 1)[0] !== encodedProtectedHeader) {
      return yield* Effect.fail(invalidCursor());
    }
    const decrypted = yield* Effect.tryPromise({
      try: () => compactDecrypt(compact, key),
      catch: invalidCursor,
    });
    if (!headerIsExact(decrypted.protectedHeader)) {
      return yield* Effect.fail(invalidCursor());
    }
    const text = yield* Effect.try({
      try: () => utf8Decoder.decode(decrypted.plaintext),
      catch: invalidCursor,
    });
    const value = yield* decodeCursorPlaintext(text);
    const canonical = canonicalize({
      agentId: value.agentId,
      routerInstanceId: value.routerInstanceId,
      lastScannedOrder: value.lastScannedOrder,
    });
    if (
      canonical === undefined ||
      !plaintextIsCurrent({
        canonical,
        text,
        agentId: value.agentId,
        callerAgentId,
        routerInstanceId: value.routerInstanceId,
        currentRouterInstanceId: routerInstanceId,
      })
    ) {
      return yield* Effect.fail(invalidCursor());
    }
    return BigInt(value.lastScannedOrder);
  });

/**
 * Creates the current-instance authenticated client-held cursor codec.
 *
 * @param input Process-local key and instance identity.
 * @param input.key Process-local direct encryption key.
 * @param input.routerInstanceId Current volatile process identity.
 * @returns A caller-bound cursor codec.
 */
export const makePollCursorCodec = (input: {
  readonly key: Uint8Array;
  readonly routerInstanceId: RouterInstanceIdValue;
}): PollCursorCodec => {
  const key = Uint8Array.from(input.key);
  const routerInstanceId = input.routerInstanceId;
  return Object.freeze({
    encrypt: ({
      agentId,
      lastScannedOrder,
    }: {
      readonly agentId: AgentId;
      readonly lastScannedOrder: bigint;
    }) => encodePollCursor(key, routerInstanceId, agentId, lastScannedOrder),
    decrypt: (cursor: PollCursorValue, callerAgentId: AgentId) =>
      decodePollCursor(key, routerInstanceId, cursor, callerAgentId),
  });
};

/**
 * Generates one process-local random Router instance identity.
 *
 * @returns A fresh random instance identifier.
 */
export const generateRouterInstanceId = (): RouterInstanceIdValue =>
  Schema.decodeUnknownSync(RouterInstanceId)(
    `rti_${Encoding.encodeBase64Url(
      globalThis.crypto.getRandomValues(new Uint8Array(16)),
    )}`,
  );

/**
 * Generates the process-local direct A256GCM key.
 *
 * @returns A fresh random 256-bit key.
 */
export const generatePollCursorKey = (): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(32));

const base64UrlLength = (byteLength: number): number =>
  Math.ceil((byteLength * 8) / 6);

/**
 * Computes exact cursor length for a caller, instance, and order width.
 *
 * @param input Plaintext cursor members.
 * @param input.agentId Caller bound into the encrypted continuation.
 * @param input.routerInstanceId Process bound into the continuation.
 * @param input.lastScannedOrder Private order bound into the continuation.
 * @returns The complete prefixed Compact JWE length.
 */
export const pollCursorEncodedLength = (input: {
  readonly agentId: AgentId;
  readonly routerInstanceId: RouterInstanceIdValue;
  readonly lastScannedOrder: bigint;
}): number => {
  const plaintext = canonicalPlaintext(input);
  if (plaintext === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const plaintextLength = utf8Encoder.encode(plaintext).byteLength;
  return (
    4 +
    // eslint-disable-next-line sonarjs/null-dereference -- module initialization always produces a string
    encodedProtectedHeader.length +
    1 +
    1 +
    16 +
    1 +
    base64UrlLength(plaintextLength) +
    1 +
    22
  );
};
