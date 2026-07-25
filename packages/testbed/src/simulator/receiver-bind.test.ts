/**
 * @file The receiver bind decision, which is what stands between a live
 * run and losing every span with no error. Measured on the two engine
 * shapes: a VM-backed engine keeps its bridge gateway inside the VM and
 * forwards `host.docker.internal` to host loopback, so loopback is
 * reachable; a native-Linux engine owns the bridge gateway as a host
 * address, and there a container reaches that address and not loopback.
 */
/* eslint-disable sonarjs/no-hardcoded-ip -- the addresses are the fixture: the decision under test is which address family the host owns */
import { describe, expect, it } from "vitest";
import { FastCheck as fc } from "effect";
import { pickReceiverBindHost } from "./launcher-live.js";

const LOOPBACK = "127.0.0.1";
const BRIDGE_GATEWAY = "172.17.0.1";

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
});
