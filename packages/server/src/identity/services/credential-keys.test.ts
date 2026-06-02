import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  generateApiKey,
  generateAppKey,
  parseApiKey,
  parseAppKey,
  hashSecret,
  safeEqual,
} from "./credential-keys.js";

const AGENT_PREFIX = "moltzap_agent_";
const APP_PREFIX = "moltzap_app_";
const KEY_ID_HEX_LEN = 16;
const SECRET_HEX_LEN = 48;
const SECRET_HASH_HEX_LEN = 64;

describe("generateApiKey / parseApiKey", () => {
  it("roundtrips a freshly minted agent key", () => {
    const { apiKey, keyId, secretHash } = generateApiKey();
    expect(apiKey.startsWith(AGENT_PREFIX)).toBe(true);
    expect(keyId).toHaveLength(KEY_ID_HEX_LEN);
    expect(secretHash).toHaveLength(SECRET_HASH_HEX_LEN);

    const parsed = parseApiKey(apiKey);
    expect(parsed).not.toBeNull();
    expect(parsed?.keyId).toBe(keyId);
    expect(parsed?.secret).toHaveLength(SECRET_HEX_LEN);
    expect(hashSecret(parsed!.secret)).toBe(secretHash);
  });

  it("rejects an app key", () => {
    const { appKey } = generateAppKey();
    expect(parseApiKey(appKey)).toBeNull();
  });
});

describe("generateAppKey / parseAppKey", () => {
  it("roundtrips a freshly minted app key", () => {
    const { appKey, keyId, secretHash } = generateAppKey();
    expect(appKey.startsWith(APP_PREFIX)).toBe(true);
    expect(keyId).toHaveLength(KEY_ID_HEX_LEN);
    expect(secretHash).toHaveLength(SECRET_HASH_HEX_LEN);

    const parsed = parseAppKey(appKey);
    expect(parsed).not.toBeNull();
    expect(parsed?.keyId).toBe(keyId);
    expect(parsed?.secret).toHaveLength(SECRET_HEX_LEN);
    expect(hashSecret(parsed!.secret)).toBe(secretHash);
  });

  it("rejects an agent key", () => {
    const { apiKey } = generateApiKey();
    expect(parseAppKey(apiKey)).toBeNull();
  });

  it("rejects malformed app keys", () => {
    expect(parseAppKey("")).toBeNull();
    expect(parseAppKey("moltzap_app_short")).toBeNull();
    expect(parseAppKey("moltzap_app_0123456789abcdef")).toBeNull();
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
    const { secretHash } = generateAppKey();
    expect(safeEqual(secretHash, secretHash)).toBe(true);
  });

  it("rejects a length mismatch without throwing", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
