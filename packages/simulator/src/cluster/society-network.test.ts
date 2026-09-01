/** @file Independent run and endpoint authority generation regressions. */

import { PrincipalId } from "@moltzap/identity";
import { OperationId } from "@moltzap/identity/registry";
import { Schema } from "effect";
import { createPrivateKey, randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import {
  generateAgentDaemonAuthority,
  generateSocietyNetworkAuthority,
} from "./society-network.js";

it("mints valid independent run and endpoint authority", () => {
  const run = generateSocietyNetworkAuthority("mz-run-1");
  const otherRun = generateSocietyNetworkAuthority("mz-run-1");
  const agent = generateAgentDaemonAuthority();

  expect(() => createPrivateKey(run.registryPrivateKeyPem)).not.toThrow();
  expect(() => createPrivateKey(agent.privateKeyPem)).not.toThrow();
  expect(run.registrySignerPublicKeyJson).toBe(
    JSON.stringify(run.registrySignerPublicKey),
  );
  expect(run.admissionCredential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(run.admissionCredential).not.toBe(otherRun.admissionCredential);
  expect(() =>
    Schema.decodeUnknownSync(OperationId)(agent.operationId),
  ).not.toThrow();
  expect(() =>
    Schema.decodeUnknownSync(PrincipalId)(agent.principalId),
  ).not.toThrow();
});

it("does not derive authority from names or deterministic state", () => {
  const namespace = `mz-${randomBytes(8).toString("hex")}`;
  const left = generateSocietyNetworkAuthority(namespace);
  const right = generateSocietyNetworkAuthority(namespace);
  const leftAgent = generateAgentDaemonAuthority();
  const rightAgent = generateAgentDaemonAuthority();

  expect(left.registryPrivateKeyPem).not.toBe(right.registryPrivateKeyPem);
  expect(leftAgent.privateKeyPem).not.toBe(rightAgent.privateKeyPem);
  expect(leftAgent.operationId).not.toBe(rightAgent.operationId);
  expect(leftAgent.principalId).not.toBe(rightAgent.principalId);
});
