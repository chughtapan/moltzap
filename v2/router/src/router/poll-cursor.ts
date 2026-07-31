import { type AgentId, AgentId as AgentIdSchema } from "@moltzap/v2-identity";
import { compactDecrypt, CompactEncrypt } from "jose";
import canonicalize from "canonicalize";
import { Data, Effect, Encoding, Schema } from "effect";
import {
  encodedPollCursorProtectedHeader,
  PollCursor,
  type PollCursor as PollCursorValue,
  pollCursorPrefix,
  pollCursorProtectedHeader,
  RouterInstanceId,
  type RouterInstanceId as RouterInstanceIdValue,
  routerInstanceIdByteLength,
} from "./contract.js";
import { maximumPrivateOrder } from "./feed.js";

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
      globalThis.crypto.getRandomValues(
        new Uint8Array(routerInstanceIdByteLength),
      ),
    )}`,
  );

/**
 * Generates the process-local direct A256GCM key.
 *
 * @returns A fresh random 256-bit key.
 */
export const generatePollCursorKey = (): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(32));

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
    header.alg === pollCursorProtectedHeader.alg &&
    header.enc === pollCursorProtectedHeader.enc &&
    header.typ === pollCursorProtectedHeader.typ
  );
};

function encodePollCursor(
  key: Uint8Array,
  routerInstanceId: RouterInstanceIdValue,
  agentId: AgentId,
  lastScannedOrder: bigint,
): Effect.Effect<PollCursorValue, PollCursorEncryptionError> {
  return Effect.gen(function* () {
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
          .setProtectedHeader(pollCursorProtectedHeader)
          .encrypt(key),
      catch: () => new PollCursorEncryptionError(),
    });
    return yield* Schema.decodeUnknown(PollCursor)(
      `${pollCursorPrefix}${compact}`,
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new PollCursorEncryptionError()),
      ),
    );
  });
}

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

function decodePollCursor(
  key: Uint8Array,
  routerInstanceId: RouterInstanceIdValue,
  cursor: PollCursorValue,
  callerAgentId: AgentId,
): Effect.Effect<bigint, PollCursorInvalidError> {
  return Effect.gen(function* () {
    const compact = cursor.slice(pollCursorPrefix.length);
    if (compact.split(".", 1)[0] !== encodedPollCursorProtectedHeader) {
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
}
