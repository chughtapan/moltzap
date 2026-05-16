import { describe, expect, it } from "vitest";
import * as flatBarrel from "../index.js";
import { agentId, userId } from "../testing/index.js";
import {
  endpointAddress,
  endpointAddressKind,
  makeEndpointAddress,
  type AuthenticatedIdentity,
  type EndpointAddress,
  type EndpointKind,
  type EndpointRegistration,
} from "./actor-model.js";

const AGENT_KIND = "agent";
const APP_KIND = "app";
const TASK_MANAGER_KIND = "taskManager";
const TASK_MANAGER_LABEL = "task manager";
const AGENT_UUID = "00000000-0000-4000-8000-000000000001";
const APP_UUID = "00000000-0000-4000-8000-000000000002";
const TASK_MANAGER_UUID = "00000000-0000-4000-8000-000000000099";
const MALFORMED_UUID = "00000000-0000-4000-8000-000000000003";
const AGENT_ENDPOINT = `tm:${AGENT_KIND}:${AGENT_UUID}`;
const APP_ENDPOINT = `tm:${APP_KIND}:${APP_UUID}`;
const TASK_MANAGER_ENDPOINT = `tm:${APP_KIND}:${TASK_MANAGER_UUID}`;
const LEGACY_AGENT_ENDPOINT = `tm:agent-conn:${MALFORMED_UUID}`;
const JOINED_KIND_ENDPOINT = `tm:agentconn:${MALFORMED_UUID}`;
const TRAILING_DASH_KIND_ENDPOINT = `tm:agent-:${MALFORMED_UUID}`;

describe("EndpointAddress construction", () => {
  it("brands a string as EndpointAddress", () => {
    const e: EndpointAddress = endpointAddress(AGENT_ENDPOINT);
    expect(e).toBe(AGENT_ENDPOINT);
  });

  it("makeEndpointAddress mints `tm:<kind>:<uuid>` for agent", () => {
    const address = makeEndpointAddress(AGENT_KIND, AGENT_UUID);
    expect(address).toBe(AGENT_ENDPOINT);
  });

  it("makeEndpointAddress mints `tm:<kind>:<uuid>` for app", () => {
    const address = makeEndpointAddress(APP_KIND, APP_UUID);
    expect(address).toBe(APP_ENDPOINT);
  });
});

describe("EndpointAddress validation", () => {
  it("rejects non-canonical endpoint formats at construction", () => {
    expect(() => endpointAddress("ws://localhost:1")).toThrow();
    expect(() => endpointAddress("")).toThrow();
    expect(() => endpointAddress("tm:agent:not-a-uuid")).toThrow();
    expect(() => endpointAddress("tm:unknown:uuid-here")).toThrow();
  });

  it("makeEndpointAddress rejects non-UUID inputs (brand predicate fires)", () => {
    expect(() => makeEndpointAddress(AGENT_KIND, "not-a-uuid")).toThrow();
    expect(() => makeEndpointAddress(APP_KIND, "not-a-uuid")).toThrow();
  });

  it("rejects the legacy `agent-conn` kind", () => {
    expect(() => endpointAddress(LEGACY_AGENT_ENDPOINT)).toThrow();
  });
});

describe("EndpointAddress kind parsing", () => {
  it("endpointAddressKind reads back the agent kind", () => {
    expect(endpointAddressKind(endpointAddress(AGENT_ENDPOINT))).toBe(
      AGENT_KIND,
    );
  });

  it("endpointAddressKind reads back the app kind", () => {
    expect(endpointAddressKind(endpointAddress(APP_ENDPOINT))).toBe(APP_KIND);
  });
});

describe("EndpointAddress malformed kind rejection", () => {
  it("rejects malformed kind segments", () => {
    expect(() => endpointAddress(JOINED_KIND_ENDPOINT)).toThrow();
    expect(() => endpointAddress(TRAILING_DASH_KIND_ENDPOINT)).toThrow();
  });
});

describe("EndpointRegistration shapes", () => {
  it("constructs an EndpointRegistration agent arm", () => {
    const reg: EndpointRegistration = {
      kind: AGENT_KIND,
      address: endpointAddress(AGENT_ENDPOINT),
      agentId: agentId(AGENT_UUID),
    };
    expect(reg.kind).toBe(AGENT_KIND);
  });

  it("constructs an EndpointRegistration taskManager arm", () => {
    const reg: EndpointRegistration = {
      kind: TASK_MANAGER_KIND,
      address: endpointAddress(TASK_MANAGER_ENDPOINT),
    };
    expect(reg.kind).toBe(TASK_MANAGER_KIND);
  });
});

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

describe("EndpointKind exhaustiveness", () => {
  it("EndpointKind switch is exhaustive", () => {
    const describeKind = (k: EndpointKind): string => {
      switch (k) {
        case AGENT_KIND:
          return AGENT_KIND;
        case TASK_MANAGER_KIND:
          return TASK_MANAGER_LABEL;
        default: {
          const _absurd: never = k;
          return _absurd;
        }
      }
    };
    expect(describeKind(AGENT_KIND)).toBe(AGENT_KIND);
    expect(describeKind(TASK_MANAGER_KIND)).toBe(TASK_MANAGER_LABEL);
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
