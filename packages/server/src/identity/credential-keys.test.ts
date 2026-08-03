import { describe, expect, it } from "vitest";
import { Redacted, Schema } from "effect";
import * as fc from "fast-check";
import { agentKey } from "@moltzap/protocol/identity";
import {
  generateApiKey,
  parseApiKey,
  hashSecret,
  safeEqual,
} from "./credential-keys.js";

const AGENT_PREFIX = "moltzap_agent_";
const KEY_ID_HEX_LEN = 16;
const SECRET_HEX_LEN = 48;
const SECRET_HASH_HEX_LEN = 64;

describe("generateApiKey / parseApiKey", () => {
  it("roundtrips a freshly minted agent key", () => {
    const { apiKey, keyId, secretHash } = generateApiKey();
    expect(Redacted.value(apiKey).startsWith(AGENT_PREFIX)).toBe(true);
    expect(keyId).toHaveLength(KEY_ID_HEX_LEN);
    expect(secretHash).toHaveLength(SECRET_HASH_HEX_LEN);

    const parsed = parseApiKey(apiKey);
    expect(parsed).not.toBeNull();
    expect(parsed?.keyId).toBe(keyId);
    expect(parsed?.secret).toHaveLength(SECRET_HEX_LEN);
    expect(
      hashSecret(
        /* Safe because the test fixture establishes this asserted shape. */ parsed!
          .secret,
      ),
    ).toBe(secretHash);
  });

  it("rejects malformed agent keys", () => {
    expect(() => Schema.decodeUnknownSync(agentKey)("")).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(agentKey)("moltzap_agent_short"),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(agentKey)("moltzap_agent_0123456789abcdef"),
    ).toThrow();
  });
});

describe("safeEqual", () => {
  it("is true exactly when the inputs are equal", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(safeEqual(a, b)).toBe(a === b);
      }),
      { numRuns: 200 },
    );
  });

  it("is reflexive on minted secrets", () => {
    const { secretHash } = generateApiKey();
    expect(safeEqual(secretHash, secretHash)).toBe(true);
  });

  it("rejects a length mismatch without throwing", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
