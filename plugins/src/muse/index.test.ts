/** @file Muse preflight cannot activate an unverified hook or disclose a runtime credential. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { preflightMuseInstallation } from "./index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- The closed unsupported status and exact missing native contracts are installation acceptance expectations. */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Muse installation preflight", () => {
  it("requires both authenticated code-only receive and accepted native wake custody", () => {
    expect(preflightMuseInstallation()).toEqual({
      platform: "muse",
      status: "unsupported",
      reason: "native-hook-contract-unverified",
      missingCapabilities: [
        "authenticated-code-only-receive",
        "native-accepted-wake-custody",
      ],
    });
  });

  it("does not treat owner approval or credential configuration as verified capability", () => {
    const credential = "fixture-private-runtime-grant";
    vi.stubEnv("MOLTZAP_MUSE_APPROVED", "true");
    vi.stubEnv("MOLTZAP_MUSE_VERIFIED", "true");
    vi.stubEnv("MOLTZAP_MCP_CREDENTIAL", credential);
    vi.stubEnv("MOLTZAP_MCP_CREDENTIAL_FILE", "/protected/runtime-grant");

    const result = preflightMuseInstallation();
    expect(result.status).toBe("unsupported");
    expect(result.missingCapabilities).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain("/protected/runtime-grant");
  });

  it("keeps the result and capability requirements immutable across callers", () => {
    const result = preflightMuseInstallation();
    expect(Reflect.set(result, "status", "ready")).toBe(false);
    expect(Reflect.set(result.missingCapabilities, "0", "verified")).toBe(
      false,
    );
    expect(result).toEqual(preflightMuseInstallation());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.missingCapabilities)).toBe(true);
  });
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore production assertion policy after the installation contract fixtures. */
