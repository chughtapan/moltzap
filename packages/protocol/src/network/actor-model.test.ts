import { describe, expect, it } from "vitest";
import * as flatBarrel from "../index.js";
import { agentId, userId } from "../testing/branded-ids.js";
import {
  endpointAddress,
  endpointAddressKind,
  makeEndpointAddress,
  type AuthenticatedIdentity,
  type EndpointAddress,
  type EndpointKind,
  type EndpointRegistration,
} from "./actor-model.js";

describe("EndpointAddress brand", () => {
  it("brands a string as EndpointAddress", () => {
    const e: EndpointAddress = endpointAddress(
      "tm:agent:00000000-0000-4000-8000-000000000001",
    );
    expect(e).toBe("tm:agent:00000000-0000-4000-8000-000000000001");
  });

  it("rejects non-canonical endpoint formats at construction", () => {
    expect(() => endpointAddress("ws://localhost:1")).toThrow();
    expect(() => endpointAddress("")).toThrow();
    expect(() => endpointAddress("tm:agent:not-a-uuid")).toThrow();
    expect(() => endpointAddress("tm:unknown:uuid-here")).toThrow();
  });

  it("makeEndpointAddress mints `tm:<kind>:<uuid>` for each declared kind", () => {
    const a = makeEndpointAddress(
      "agent",
      "00000000-0000-4000-8000-000000000001",
    );
    expect(a).toBe("tm:agent:00000000-0000-4000-8000-000000000001");
    const b = makeEndpointAddress(
      "app",
      "00000000-0000-4000-8000-000000000002",
    );
    expect(b).toBe("tm:app:00000000-0000-4000-8000-000000000002");
  });

  it("makeEndpointAddress rejects non-UUID inputs (brand predicate fires)", () => {
    expect(() => makeEndpointAddress("agent", "not-a-uuid")).toThrow();
    expect(() => makeEndpointAddress("app", "not-a-uuid")).toThrow();
  });

  it("endpointAddressKind reads back the kind for each declared kind", () => {
    expect(
      endpointAddressKind(
        endpointAddress("tm:agent:00000000-0000-4000-8000-000000000001"),
      ),
    ).toBe("agent");
    expect(
      endpointAddressKind(
        endpointAddress("tm:app:00000000-0000-4000-8000-000000000002"),
      ),
    ).toBe("app");
  });

  it("rejects the legacy `agent-conn` kind", () => {
    expect(() =>
      endpointAddress("tm:agent-conn:00000000-0000-4000-8000-000000000003"),
    ).toThrow();
  });

  it("rejects malformed kind segments", () => {
    expect(() =>
      endpointAddress("tm:agentconn:00000000-0000-4000-8000-000000000003"),
    ).toThrow();
    expect(() =>
      endpointAddress("tm:agent-:00000000-0000-4000-8000-000000000003"),
    ).toThrow();
  });
});

describe("actor-model record + union shapes", () => {
  it("constructs an EndpointRegistration agent arm", () => {
    const reg: EndpointRegistration = {
      kind: "agent",
      address: endpointAddress("tm:agent:00000000-0000-4000-8000-000000000001"),
      agentId: agentId("00000000-0000-4000-8000-000000000001"),
    };
    expect(reg.kind).toBe("agent");
  });

  it("constructs an EndpointRegistration taskManager arm", () => {
    const reg: EndpointRegistration = {
      kind: "taskManager",
      address: endpointAddress("tm:app:00000000-0000-4000-8000-000000000099"),
    };
    expect(reg.kind).toBe("taskManager");
  });

  it("constructs an AuthenticatedIdentity", () => {
    const identity: AuthenticatedIdentity = {
      agentId: agentId("00000000-0000-4000-8000-000000000001"),
      userId: userId("00000000-0000-4000-8000-000000000002"),
    };
    expect(identity.agentId).toBe("00000000-0000-4000-8000-000000000001");
    expect(identity.userId).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("EndpointKind switch is exhaustive", () => {
    const describeKind = (k: EndpointKind): string => {
      switch (k) {
        case "agent":
          return "agent";
        case "taskManager":
          return "task manager";
        default: {
          const _absurd: never = k;
          return _absurd;
        }
      }
    };
    expect(describeKind("agent")).toBe("agent");
    expect(describeKind("taskManager")).toBe("task manager");
  });
});

describe("flat-barrel runtime negative canary", () => {
  // Internal symbols not surfaced via any public path. The actor-model
  // helpers (`endpointAddress`, etc.) are intentionally re-exported via
  // `@moltzap/protocol/network` and `@moltzap/protocol`.
  const FORBIDDEN_RUNTIME_NAMES = [
    "EndpointKind",
    "EndpointRegistration",
    "AuthenticatedIdentity",
  ] as const;

  const flatBarrelKeys = Object.keys(flatBarrel);

  for (const name of FORBIDDEN_RUNTIME_NAMES) {
    it(`@moltzap/protocol does not re-export "${name}"`, () => {
      expect(flatBarrelKeys).not.toContain(name);
    });
  }
});
