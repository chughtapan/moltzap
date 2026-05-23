import { describe, expect, it } from "vitest";
import * as flatBarrel from "../index.js";
import { agentId, userId } from "../testing/index.js";
import { type AuthenticatedIdentity } from "./actor-model.js";

const AGENT_UUID = "00000000-0000-4000-8000-000000000001";
const APP_UUID = "00000000-0000-4000-8000-000000000002";

describe("AuthenticatedIdentity shape", () => {
  it("constructs an AuthenticatedIdentity", () => {
    const identity: AuthenticatedIdentity = {
      agentId: agentId(AGENT_UUID),
      userId: userId(APP_UUID),
    };
    expect(identity.agentId).toBe(AGENT_UUID);
    expect(identity.userId).toBe(APP_UUID);
  });
});

describe("flat-barrel runtime negative canary", () => {
  // `AuthenticatedIdentity` is a type-only export; runtime keys MUST NOT
  // surface it. The forbidden list also pins that the deleted
  // `EndpointAddress` brand + endpoint-kind machinery stay deleted.
  const FORBIDDEN_RUNTIME_NAMES = [
    "AuthenticatedIdentity",
    "EndpointAddress",
    "EndpointAddressKind",
    "EndpointKind",
    "EndpointRegistration",
    "endpointAddress",
    "endpointAddressKind",
    "makeEndpointAddress",
    "isEndpointAddress",
  ] as const;

  const flatBarrelKeys = Object.keys(flatBarrel);

  for (const name of FORBIDDEN_RUNTIME_NAMES) {
    it(`@moltzap/protocol does not re-export "${name}"`, () => {
      expect(flatBarrelKeys).not.toContain(name);
    });
  }
});
