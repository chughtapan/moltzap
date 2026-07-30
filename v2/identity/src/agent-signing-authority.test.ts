import {
  AgentSigningAuthority,
  InvalidAgentPrivateKeyError,
  agentSigningPrivateKey,
} from "./agent-signing-authority.js";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { Effect, Redacted } from "effect";
import * as fc from "fast-check";
import { importJWK } from "jose";
import { expect, it } from "vitest";

const RFC_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g
-----END PRIVATE KEY-----`;
const RFC_PUBLIC_X = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const X25519_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VuBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
-----END PRIVATE KEY-----`;
const PUBLIC_ONLY_KEY = createPublicKey(
  createPrivateKey(RFC_PRIVATE_KEY),
).export({
  type: "spki",
  format: "pem",
});
const PRIVATE_SENTINEL = "private-sentinel-must-not-escape";
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

const pemFromDer = (der: Uint8Array): string => {
  const base64 = Buffer.from(der).toString("base64");
  const lines = base64.match(/.{1,64}/g);
  return `-----BEGIN PRIVATE KEY-----\n${lines?.join("\n") ?? ""}\n-----END PRIVATE KEY-----`;
};

const publicJwk = (privateKey: KeyObject) =>
  createPublicKey(privateKey).export({ format: "jwk" });

const compareGeneratedSeedWithNode = (seed: Uint8Array) => {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]);
  const expected = publicJwk(
    createPrivateKey({
      key: der,
      format: "der",
      type: "pkcs8",
    }),
  );

  return Effect.gen(function* () {
    const authority = yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(pemFromDer(der)),
    );
    expect(AgentSigningAuthority.publicKey(authority).x).toBe(expected.x);
  });
};

it("imports an Ed25519 PKCS#8 key as an opaque AgentSigningAuthority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const authority = yield* AgentSigningAuthority.fromPkcs8(
        Redacted.make(RFC_PRIVATE_KEY),
      );
      const publicKey = AgentSigningAuthority.publicKey(authority);
      const privateKey = agentSigningPrivateKey(authority);
      const payload = new TextEncoder().encode("identity-authority");
      const signature = yield* Effect.tryPromise({
        try: () => crypto.subtle.sign("Ed25519", privateKey, payload),
        catch: () => new Error("signing failed"),
      });
      const verifyingKey = yield* Effect.tryPromise({
        try: () => importJWK(publicKey, "Ed25519"),
        catch: () => new Error("public-key import failed"),
      });
      const verifies = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.verify("Ed25519", verifyingKey, signature, payload),
        catch: () => new Error("signature verification failed"),
      });

      expect(publicKey).toEqual({
        crv: "Ed25519",
        kty: "OKP",
        x: RFC_PUBLIC_X,
      });
      expect(verifies).toBe(true);
      expect(privateKey).toMatchObject({
        algorithm: { name: "Ed25519" },
        extractable: false,
        type: "private",
        usages: ["sign"],
      });
      expect(Reflect.set(publicKey, "x", "A".repeat(43))).toBe(false);
      expect(AgentSigningAuthority.publicKey(authority).x).toBe(RFC_PUBLIC_X);
    }),
  ));

it("matches Node's public-key derivation for generated Ed25519 seeds", () =>
  fc.assert(
    fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), (seed) =>
      Effect.runPromise(compareGeneratedSeedWithNode(seed)),
    ),
    { numRuns: 32 },
  ));

it("collapses unusable private keys to InvalidAgentPrivateKeyError without leaking input", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const encryptedKey = createPrivateKey(RFC_PRIVATE_KEY).export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "test-passphrase",
      });
      const inputs = [
        PRIVATE_SENTINEL,
        X25519_PRIVATE_KEY,
        PUBLIC_ONLY_KEY,
        encryptedKey,
        `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA${PRIVATE_SENTINEL}
-----END PUBLIC KEY-----`,
      ];

      for (const input of inputs) {
        const error = yield* AgentSigningAuthority.fromPkcs8(
          Redacted.make(input),
        ).pipe(Effect.flip);

        expect(error).toStrictEqual(new InvalidAgentPrivateKeyError());
        expect(JSON.stringify(error)).not.toContain(PRIVATE_SENTINEL);
        expect(String(error)).not.toContain(PRIVATE_SENTINEL);
      }
    }),
  ));
