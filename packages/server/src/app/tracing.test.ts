import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { resolveTracesEndpoint } from "./tracing.js";

// Protocol-agnostic join logic; https keeps the clear-text-protocol lint happy.
const BASE = "https://collector:4318";
const TRACES_SUFFIX = "/v1/traces";
const TRACES_ENDPOINT = "https://traces-host/custom";

describe("resolveTracesEndpoint", () => {
  test("returns null when neither endpoint is set", () => {
    expect(resolveTracesEndpoint(undefined, undefined)).toBeNull();
  });

  test("appends the traces path to the base endpoint", () => {
    expect(resolveTracesEndpoint(undefined, BASE)).toBe(
      `${BASE}${TRACES_SUFFIX}`,
    );
  });

  test("normalizes a trailing slash on the base endpoint (no double slash)", () => {
    expect(resolveTracesEndpoint(undefined, `${BASE}/`)).toBe(
      `${BASE}${TRACES_SUFFIX}`,
    );
  });

  test("collapses multiple trailing slashes on the base endpoint", () => {
    expect(resolveTracesEndpoint(undefined, `${BASE}///`)).toBe(
      `${BASE}${TRACES_SUFFIX}`,
    );
  });

  test("uses the trace-specific endpoint verbatim", () => {
    expect(resolveTracesEndpoint(`${BASE}${TRACES_SUFFIX}`, undefined)).toBe(
      `${BASE}${TRACES_SUFFIX}`,
    );
  });

  test("trace-specific endpoint takes precedence over the base endpoint", () => {
    expect(resolveTracesEndpoint(TRACES_ENDPOINT, BASE)).toBe(TRACES_ENDPOINT);
  });

  test("does not suffix the trace-specific endpoint (used as the full URL)", () => {
    expect(resolveTracesEndpoint(`${TRACES_ENDPOINT}/`, undefined)).toBe(
      `${TRACES_ENDPOINT}/`,
    );
  });

  // Invariant: for any base endpoint, the resolved URL ends in exactly one
  // `/v1/traces` with no `//` at the join, regardless of trailing slashes.
  test("base-endpoint join never produces a double slash", () => {
    fc.assert(
      fc.property(
        fc.webUrl().filter((u) => !u.endsWith(TRACES_SUFFIX)),
        fc.nat({ max: 5 }),
        (root, extraSlashes) => {
          const base = `${root}${"/".repeat(extraSlashes)}`;
          const resolved = resolveTracesEndpoint(undefined, base);
          expect(resolved).not.toBeNull();
          const url = resolved as string;
          expect(url.endsWith(TRACES_SUFFIX)).toBe(true);
          expect(url).not.toContain(`/${TRACES_SUFFIX}`);
        },
      ),
    );
  });
});
