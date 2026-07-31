import {
  Ed25519PublicKey,
  ed25519PublicKeyThumbprintUri,
  hasCanonicalEd25519SignatureEncoding,
} from "../agent-key.js";
import { it as effectIt } from "@effect/vitest";
import { Effect, Either, Schema } from "effect";
import { generateKeyPairSync, sign as signWithPrivateKey } from "node:crypto";
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

const smallOrderPointHex = [
  "00".repeat(32),
  `01${"00".repeat(31)}`,
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  `ec${"ff".repeat(30)}7f`,
  `ed${"ff".repeat(30)}7f`,
  `ee${"ff".repeat(30)}7f`,
] as const;

const encodePoint = (hex: string, highBit: boolean): string => {
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  const finalByte = bytes[31];
  if (highBit && finalByte !== undefined) {
    bytes[31] = finalByte | 0x80;
  }
  return Buffer.from(bytes).toString("base64url");
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
  it("round-trips generated Ed25519 public keys", () => {
    for (let index = 0; index < 16; index += 1) {
      const { publicKey } = generateKeyPairSync("ed25519");
      const exported = publicKey.export({ format: "jwk" });
      const representation = {
        crv: "Ed25519" as const,
        kty: "OKP" as const,
        x: exported.x,
      };
      const decoded =
        Schema.decodeUnknownSync(Ed25519PublicKey)(representation);
      expect(Schema.encodeSync(Ed25519PublicKey)(decoded)).toEqual(
        representation,
      );
    }
  });

  it("returns an immutable snapshot", () => {
    const source = { ...validPublicKey };
    const publicKey = Schema.decodeUnknownSync(Ed25519PublicKey)(source);
    source.x = "A".repeat(43);

    expect(Object.isFrozen(publicKey)).toBe(true);
    expect(Reflect.set(publicKey, "x", "A".repeat(43))).toBe(false);
    expect(publicKey.x).toBe(RFC_PUBLIC_X);
  });
});

describe("Ed25519PublicKey rejection", () => {
  it.each(invalidPublicKeys)("rejects $description", ({ representation }) => {
    expect(decodeSucceeds(representation)).toBe(false);
  });

  it("rejects every small-order encoding with either sign bit", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...smallOrderPointHex),
        fc.boolean(),
        (hex, highBit) => {
          const representation = {
            ...validPublicKey,
            x: encodePoint(hex, highBit),
          };
          expect(decodeSucceeds(representation)).toBe(false);
        },
      ),
    );
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

describe("Ed25519 signature representation", () => {
  it("accepts signatures produced by an Ed25519 private key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signature = signWithPrivateKey(
      null,
      Buffer.from("accepted signature"),
      privateKey,
    );

    expect(hasCanonicalEd25519SignatureEncoding(signature)).toBe(true);
  });

  it("rejects a scalar equal to the Ed25519 group order", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signature = Uint8Array.from(
      signWithPrivateKey(null, Buffer.from("scalar boundary"), privateKey),
    );
    signature.set(
      [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2,
        0xde, 0xf9, 0xde, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
      ],
      32,
    );

    expect(hasCanonicalEd25519SignatureEncoding(signature)).toBe(false);
  });

  it("rejects an R coordinate equal to the field modulus", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signature = Uint8Array.from(
      signWithPrivateKey(null, Buffer.from("point boundary"), privateKey),
    );
    signature.set([
      0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
    ]);

    expect(hasCanonicalEd25519SignatureEncoding(signature)).toBe(false);
  });
});
