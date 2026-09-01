/** @file Cluster failure tagging and operator-visible diagnostic regressions. */

import { describe, expect, it } from "vitest";
import { ClusterError, clusterError } from "./cluster.js";

const OPERATION = "create agent sandbox";
const CAUSE_DETAIL = "sandbox admission webhook rejected the pod";

describe("clusterError", () => {
  it("names the failed operation and its cause when stringified", () => {
    const failure = clusterError(OPERATION, new Error(CAUSE_DETAIL));

    // The ledger and the operator both read this through String(), so a failure
    // that only carries its detail on a field reports nothing either can use.
    expect(String(failure)).toContain(OPERATION);
    expect(String(failure)).toContain(CAUSE_DETAIL);
    expect(failure.message).toBe(`${OPERATION}: ${CAUSE_DETAIL}`);
  });

  it("reads the same whether the boundary threw an Error or a description", () => {
    const thrown = clusterError(OPERATION, new Error(CAUSE_DETAIL));
    const described = clusterError(OPERATION, CAUSE_DETAIL);

    expect(described.message).toBe(thrown.message);
  });

  it("keeps the tag a caller matches on", () => {
    const failure = clusterError(OPERATION, CAUSE_DETAIL);

    expect(failure).toBeInstanceOf(ClusterError);
    expect(failure._tag).toBe(new ClusterError({ detail: "" })._tag);
  });
});
