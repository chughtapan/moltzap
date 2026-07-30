import {
  Ed25519PublicKey,
  ed25519PublicKeyThumbprintUri,
} from "./ed25519-public-key.js";
import { it as effectIt } from "@effect/vitest";
import { Effect, Either, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";

const it = effectIt;
const RFC_PUBLIC_X = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const RFC_THUMBPRINT_URI =
  "urn:ietf:params:oauth:jwk-thumbprint:sha-256:kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";

const validPublicKey = {
  crv: "Ed25519",
  kty: "OKP",
  x: RFC_PUBLIC_X,
};

const invalidPublicKeys = [
  {
    description: "missing crv",
    representation: { kty: "OKP", x: RFC_PUBLIC_X },
  },
  {
    description: "wrong crv",
    representation: { ...validPublicKey, crv: "ed25519" },
  },
  {
    description: "wrong kty",
    representation: { ...validPublicKey, kty: "EC" },
  },
  {
    description: "short x",
    representation: { ...validPublicKey, x: "A".repeat(42) },
  },
  {
    description: "long x",
    representation: { ...validPublicKey, x: "A".repeat(44) },
  },
  {
    description: "padded x",
    representation: { ...validPublicKey, x: `${RFC_PUBLIC_X}=` },
  },
  {
    description: "standard alphabet",
    representation: { ...validPublicKey, x: `${"A".repeat(42)}/` },
  },
  {
    description: "whitespace",
    representation: { ...validPublicKey, x: `${"A".repeat(42)} ` },
  },
  {
    description: "nonzero trailing bits",
    representation: { ...validPublicKey, x: `${"A".repeat(42)}B` },
  },
  {
    description: "private material",
    representation: { ...validPublicKey, d: "A".repeat(43) },
  },
  {
    description: "algorithm",
    representation: { ...validPublicKey, alg: "Ed25519" },
  },
  {
    description: "key identifier",
    representation: { ...validPublicKey, kid: "key" },
  },
  {
    description: "unknown member",
    representation: { ...validPublicKey, extension: true },
  },
] as const;

const decodeSucceeds = (value: unknown): boolean =>
  Either.match(Schema.decodeUnknownEither(Ed25519PublicKey)(value), {
    onLeft: () => false,
    onRight: () => true,
  });

const encodeSucceeds = (value: unknown): boolean =>
  Either.match(Schema.encodeUnknownEither(Ed25519PublicKey)(value), {
    onLeft: () => false,
    onRight: () => true,
  });

describe("Ed25519PublicKey thumbprints", () => {
  it.effect("matches the RFC thumbprint URI", () =>
    Effect.gen(function* () {
      const publicKey =
        yield* Schema.decodeUnknown(Ed25519PublicKey)(validPublicKey);
      const thumbprint = yield* ed25519PublicKeyThumbprintUri(publicKey);
      expect(thumbprint).toBe(RFC_THUMBPRINT_URI);
      expect(Schema.encodeSync(Ed25519PublicKey)(publicKey)).toEqual(
        validPublicKey,
      );
    }),
  );
});

describe("Ed25519PublicKey representation", () => {
  it("round-trips every canonical 32-byte coordinate", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        const representation = {
          crv: "Ed25519",
          kty: "OKP",
          x: Buffer.from(bytes).toString("base64url"),
        };
        const publicKey =
          Schema.decodeUnknownSync(Ed25519PublicKey)(representation);
        expect(Schema.encodeSync(Ed25519PublicKey)(publicKey)).toEqual(
          representation,
        );
      }),
    );
  });

  it("returns an immutable snapshot", () => {
    const source = { ...validPublicKey };
    const publicKey = Schema.decodeUnknownSync(Ed25519PublicKey)(source);
    source.x = "A".repeat(43);

    expect(Object.isFrozen(publicKey)).toBe(true);
    expect(Reflect.set(publicKey, "x", "A".repeat(43))).toBe(false);
    expect(publicKey.x).toBe(RFC_PUBLIC_X);
  });

  it.each(invalidPublicKeys)("rejects $description", ({ representation }) => {
    expect(decodeSucceeds(representation)).toBe(false);
  });

  it("rejects hidden members on encoded domain values", () => {
    const privateMaterial = { ...validPublicKey };
    Object.defineProperty(privateMaterial, "d", {
      enumerable: false,
      value: "A".repeat(43),
    });
    const symbolMember = {
      ...validPublicKey,
      [Symbol("private")]: "A".repeat(43),
    };

    expect(encodeSucceeds(Object.freeze(privateMaterial))).toBe(false);
    expect(encodeSucceeds(Object.freeze(symbolMember))).toBe(false);
  });
});
