import * as Identity from "@moltzap/v2-identity";
import { describe, expect, it } from "vitest";

describe("identity package", () => {
  it("loads its built public entry", () => {
    expect(Identity.MOLTZAP_VERSION).toMatch(/^\d{4}\.\d{3,4}\.\d+$/);
  });

  it("exposes exactly the approved identity foundation", () => {
    expect(new Set(Object.keys(Identity))).toEqual(
      new Set([
        "AgentCardDigest",
        "AgentId",
        "AgentName",
        "AgentSigningAuthority",
        "Ed25519PublicKey",
        "InvalidAgentPrivateKeyError",
        "MOLTZAP_VERSION",
        "MessageId",
        "OperationId",
        "PrincipalId",
      ]),
    );
  });
});
