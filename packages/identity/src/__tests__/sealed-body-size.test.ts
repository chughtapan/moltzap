/** @file SealedBody exact sizes, size limits, and size refusals. */

import { Effect, Either, Option } from "effect";
import * as fc from "fast-check";
import { expect, it } from "vitest";
import { SealedBody } from "../sealed-body.js";
import { SignedMessageSigningError } from "../signed-message.js";
import {
  type Group,
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
  makeGroup,
  openAs,
  sealFrom,
  signBody,
} from "./sealed-body-fixtures.js";

const SIGNED_MESSAGE_BODY_CAP = 262_144;

/**
 * At 32 recipients a sealed body is `ceil(4(N + 32) / 3) + 5,789` bytes, so
 * this is the largest plaintext whose sealed body fits the SignedMessage body
 * cap.
 */
const LARGEST_32_RECIPIENT_PLAINTEXT_BYTES = 192_234;

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
 * Runs `expectExactRoundTrip` over generated plaintexts of 0 to 2,048 bytes,
 * always including the empty plaintext, whose salted form is exactly the salt
 * and so sits on the boundary of the short-plaintext refusal.
 *
 * @param group Sender, peer, and recipients.
 * @returns The fast-check run, rejecting with the shrunk counterexample.
 */
const generatedPlaintextsRoundTrip = (group: Group) =>
  fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 2048 }), (bytes) =>
      Effect.runPromise(expectExactRoundTrip(group, bytes)),
    ),
    { numRuns: 16, examples: [[new Uint8Array()]] },
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

it.each([
  { recipientCount: 1, plaintextBytes: 0, sealedBytes: 548 },
  { recipientCount: 1, plaintextBytes: 1000, sealedBytes: 1881 },
  { recipientCount: 2, plaintextBytes: 1, sealedBytes: 703 },
  { recipientCount: 3, plaintextBytes: 1000, sealedBytes: 2206 },
  { recipientCount: 32, plaintextBytes: 1000, sealedBytes: 7165 },
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
