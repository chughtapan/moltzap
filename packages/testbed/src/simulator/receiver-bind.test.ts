/**
 * @file The receiver bind decision and the endpoint the container is
 * handed — together, what stands between a live run and losing every
 * span with no error. Measured on the two engine shapes: a VM-backed
 * engine keeps its bridge gateway inside the VM and forwards
 * `host.docker.internal` to host loopback, so loopback is reachable; a
 * native-Linux engine owns the bridge gateway as a host address, and
 * there a container reaches that address and not loopback.
 */
/* eslint-disable sonarjs/no-hardcoded-ip -- the addresses are the fixture: the decision under test is which address family the host owns */
import { describe, expect, it } from "vitest";
import { FastCheck as fc } from "effect";
import {
  containerReachableEndpoint,
  pickReceiverBindHost,
} from "./launcher-live.js";

const LOOPBACK = "127.0.0.1";
const BRIDGE_GATEWAY = "172.17.0.1";
const HOST_ALIAS = "host.docker.internal";

/** What the engine reports: addresses the host does not own, then the one it does. */
function reportedGateways(
  unowned: ReadonlyArray<string>,
  owned: string,
): ReadonlyArray<string> {
  return [...unowned.filter((value) => value !== owned), owned];
}

describe("receiver bind host", () => {
  it("binds the bridge gateway when the host owns it (native-Linux engine)", () => {
    const addresses = new Set([LOOPBACK, BRIDGE_GATEWAY, "10.0.0.5"]);
    expect(pickReceiverBindHost([BRIDGE_GATEWAY], addresses)).toBe(
      BRIDGE_GATEWAY,
    );
  });

  it("binds loopback when the gateway lives in the engine's VM", () => {
    const addresses = new Set([LOOPBACK, "10.0.0.32"]);
    expect(pickReceiverBindHost([BRIDGE_GATEWAY], addresses)).toBe(LOOPBACK);
  });

  it("never binds an address this host does not own (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 6 }),
        fc.array(fc.string(), { maxLength: 6 }),
        (gateways, owned) => {
          const addresses = new Set([LOOPBACK, ...owned]);
          const picked = pickReceiverBindHost(gateways, addresses);
          // Loopback is always bindable; anything else has to be an
          // address the engine reported AND the host actually holds,
          // because the launcher advertises exactly what got bound.
          expect(
            picked === LOOPBACK ||
              (addresses.has(picked) && gateways.includes(picked)),
          ).toBe(true);
        },
      ),
    );
  });

  it("takes the engine's gateway whenever this host owns it (property)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((value) => value !== LOOPBACK),
        fc.array(fc.string(), { maxLength: 4 }),
        // The half a loopback-only implementation fails: an owned gateway
        // is what the receiver binds, whatever else the engine reported
        // ahead of it.
        (gateway, unowned) => {
          expect(
            pickReceiverBindHost(
              reportedGateways(unowned, gateway),
              new Set([LOOPBACK, gateway]),
            ),
          ).toBe(gateway);
        },
      ),
    );
  });
});

describe("container-reachable endpoint", () => {
  it("rewrites a loopback bind to the engine's host alias", () => {
    expect(
      containerReachableEndpoint(`http://${LOOPBACK}:4318/v1/traces`),
    ).toBe(`http://${HOST_ALIAS}:4318/v1/traces`);
    expect(containerReachableEndpoint("http://localhost:4318/v1/traces")).toBe(
      `http://${HOST_ALIAS}:4318/v1/traces`,
    );
  });

  it("passes a gateway bind through, because that is the address the container dials", () => {
    expect(
      containerReachableEndpoint(`http://${BRIDGE_GATEWAY}:4318/v1/traces`),
    ).toBe(`http://${BRIDGE_GATEWAY}:4318/v1/traces`);
  });

  it("rewrites the hostname only, never a loopback literal elsewhere", () => {
    expect(
      containerReachableEndpoint(
        `http://${LOOPBACK}:4318/v1/traces?to=${LOOPBACK}`,
      ),
    ).toBe(`http://${HOST_ALIAS}:4318/v1/traces?to=${LOOPBACK}`);
  });
});
