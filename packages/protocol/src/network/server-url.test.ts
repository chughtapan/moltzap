import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { httpBaseUrl, serverBaseUrl, webSocketUrl } from "./index.js";

const PROPERTY_RUNS = 100;
const PATH_BEARING_URL = "http://localhost:9999/elsewhere";
const DOUBLED_ROUTE = "/ws/ws";
const WS_SCHEME = /^wss?:$/;
const HTTP_SCHEME = /^https?:$/;

// Schemes are case-insensitive on the wire, so a caller may hold any spelling.
const arbScheme = fc.constantFrom(
  "http",
  "https",
  "ws",
  "wss",
  "HTTP",
  "HTTPS",
  "WS",
  "Wss",
);
const arbHost = fc.constantFrom(
  "localhost",
  "127.0.0.1",
  "api.moltzap.xyz",
  "host.docker.internal",
);
const arbAuthority = fc
  .tuple(arbHost, fc.option(fc.integer({ min: 1, max: 65_535 }), { nil: null }))
  .map(([host, port]) => (port === null ? host : `${host}:${String(port)}`));
const arbBase = fc
  .tuple(arbScheme, arbAuthority)
  .map(([scheme, authority]) => `${scheme}://${authority}`);
// The forms a caller may hold for one server: the base, the base with a
// trailing slash, and the socket endpoint in either spelling.
const arbSuffix = fc.constantFrom("", "/", "/ws", "/ws/");

// The value is rebuilt from the parsed URL, so the scheme reaches
// `webSocketUrl` in the spelling its swap matches and the authority in the
// spelling the socket dials.
describe("ServerBaseUrl canonicalization", () => {
  it.each([
    ["HTTP://localhost:3000", "http://localhost:3000"],
    ["HTTPS://api.moltzap.xyz", "https://api.moltzap.xyz"],
    ["WS://localhost:3000/ws", "ws://localhost:3000"],
    ["http://LOCALHOST:3000", "http://localhost:3000"],
    ["http://localhost:80", "http://localhost"],
    ["https://api.moltzap.xyz:443", "https://api.moltzap.xyz"],
    ["http://localhost//", "http://localhost"],
    ["http://localhost//ws", "http://localhost"],
    ["  http://localhost:3000  ", "http://localhost:3000"],
  ])("canonicalizes %s to %s", (input, expected) => {
    expect(serverBaseUrl(input)).toBe(expected);
  });
});

describe("ServerBaseUrl", () => {
  it.each([
    ["ws://127.0.0.1:32821/ws", "ws://127.0.0.1:32821"],
    ["ws://127.0.0.1:32821/ws/", "ws://127.0.0.1:32821"],
    ["wss://api.moltzap.xyz/ws", "wss://api.moltzap.xyz"],
    ["http://localhost:3000/ws", "http://localhost:3000"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["https://api.moltzap.xyz", "https://api.moltzap.xyz"],
  ])("decodes %s to %s", (input, expected) => {
    expect(serverBaseUrl(input)).toBe(expected);
  });

  it.each([
    "ws://localhost/ws/ws",
    PATH_BEARING_URL,
    "http://localhost/ws/extra",
    "http://localhost/?query=1",
    "http://localhost#fragment",
    // The authority form cannot carry credentials, so accepting these would
    // drop them silently.
    "http://user:secret@localhost",
    "file:///srv/moltzap",
    "not a url",
    "",
  ])("rejects %s", (input) => {
    expect(() => serverBaseUrl(input)).toThrow();
  });

  it("names the offending value in the failure", () => {
    expect(() => serverBaseUrl(PATH_BEARING_URL)).toThrow(PATH_BEARING_URL);
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(arbBase, arbSuffix, (base, suffix) => {
        const held = `${base}${suffix}`;
        expect(serverBaseUrl(serverBaseUrl(held))).toBe(serverBaseUrl(held));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe("webSocketUrl", () => {
  it.each([
    ["http://localhost:3000", "ws://localhost:3000/ws"],
    ["https://api.moltzap.xyz", "wss://api.moltzap.xyz/ws"],
    ["ws://127.0.0.1:32821/ws", "ws://127.0.0.1:32821/ws"],
    ["ws://127.0.0.1:32821/ws/", "ws://127.0.0.1:32821/ws"],
  ])("dials %s at %s", (input, expected) => {
    expect(webSocketUrl(serverBaseUrl(input))).toBe(expected);
  });

  it("appends the route exactly once, whichever form the caller holds", () => {
    fc.assert(
      fc.property(arbBase, arbSuffix, (base, suffix) => {
        const endpoint = webSocketUrl(serverBaseUrl(`${base}${suffix}`));
        expect(endpoint).toBe(webSocketUrl(serverBaseUrl(base)));
        expect(endpoint).not.toContain(DOUBLED_ROUTE);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("always yields a URL a socket can open", () => {
    fc.assert(
      fc.property(arbBase, arbSuffix, (base, suffix) => {
        const endpoint = webSocketUrl(serverBaseUrl(`${base}${suffix}`));
        expect(new URL(endpoint).protocol).toMatch(WS_SCHEME);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe("httpBaseUrl", () => {
  it.each([
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://api.moltzap.xyz", "https://api.moltzap.xyz"],
    ["ws://127.0.0.1:32821/ws", "http://127.0.0.1:32821"],
    ["wss://api.moltzap.xyz/ws/", "https://api.moltzap.xyz"],
  ])("addresses %s at %s", (input, expected) => {
    expect(httpBaseUrl(serverBaseUrl(input))).toBe(expected);
  });

  it("always yields an HTTP control-plane origin", () => {
    fc.assert(
      fc.property(arbBase, arbSuffix, (base, suffix) => {
        const controlPlane = httpBaseUrl(serverBaseUrl(`${base}${suffix}`));
        const url = new URL(controlPlane);
        expect(url.protocol).toMatch(HTTP_SCHEME);
        expect(url.pathname).toBe("/");
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
