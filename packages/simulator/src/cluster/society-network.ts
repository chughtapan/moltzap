/** @file Run-private Registry, Router, and endpoint bootstrap authority. */

import {
  Ed25519PublicKey,
  type Ed25519PublicKey as Ed25519PublicKeyValue,
  PrincipalId,
  type PrincipalId as PrincipalIdValue,
} from "@moltzap/identity";
import {
  OperationId,
  type OperationId as OperationIdValue,
} from "@moltzap/identity/registry";
import { Schema } from "effect";
import { generateKeyPairSync, randomBytes } from "node:crypto";

const IDENTIFIER_BYTES = 16;
const CREDENTIAL_BYTES = 32;

/** Stable run-local Registry Service identity. */
export const REGISTRY_SERVICE_NAME = "registry";
/** Registry HTTP port inside one run namespace. */
export const REGISTRY_PORT = 4_317;
/** Stable run-local Router Service identity. */
export const ROUTER_SERVICE_NAME = "router";
/** Router HTTP port inside one run namespace. */
export const ROUTER_PORT = 4_318;
/** Loopback daemon MCP port shared by every isolated agent Pod. */
export const DAEMON_MCP_PORT = 4_319;
/** Secret key containing one endpoint's PKCS#8 signing key. */
export const AGENT_PRIVATE_KEY_SECRET_KEY = "agent-private-key.pem";
/** Secret key containing the run-wide Registry admission credential. */
export const ADMISSION_CREDENTIAL_SECRET_KEY = "admission-credential";
/** Secret key containing the Registry's PKCS#8 signing key. */
export const REGISTRY_PRIVATE_KEY_SECRET_KEY = "registry-private-key.pem";

/** Secret authority held only by run infrastructure and daemon containers. */
export interface SocietyNetworkAuthority {
  readonly registryPrivateKeyPem: string;
  readonly registrySignerPublicKey: Ed25519PublicKeyValue;
  readonly registrySignerPublicKeyJson: string;
  readonly admissionCredential: string;
  readonly registryOrigin: string;
  readonly routerOrigin: string;
}

/** Non-secret, run-owned network values passed to endpoint manifests. */
export interface SocietyNetworkConfiguration {
  readonly registryOrigin: string;
  readonly routerOrigin: string;
  readonly registrySignerPublicKeyJson: string;
}

/** Per-agent values consumed only by the daemon and one-shot registrar. */
export interface AgentDaemonAuthority {
  readonly privateKeyPem: string;
  readonly operationId: OperationIdValue;
  readonly principalId: PrincipalIdValue;
}

/**
 * Mint the sole Registry signing key and admission authority for one run.
 * @param namespace Validated run namespace used only for private Service URLs.
 * @returns Complete secret and public network configuration.
 */
export function generateSocietyNetworkAuthority(
  namespace: string,
): SocietyNetworkAuthority {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const exported = publicKey.export({ format: "jwk" });
  const registrySignerPublicKey = Schema.decodeUnknownSync(Ed25519PublicKey)({
    crv: exported.crv,
    kty: exported.kty,
    x: exported.x,
  });
  const encoded = Schema.encodeSync(Ed25519PublicKey)(registrySignerPublicKey);
  return Object.freeze({
    registryPrivateKeyPem: privateKey
      .export({
        format: "pem",
        type: "pkcs8",
      })
      .toString(),
    registrySignerPublicKey,
    registrySignerPublicKeyJson: JSON.stringify(encoded),
    admissionCredential: randomBytes(CREDENTIAL_BYTES).toString("base64url"),
    registryOrigin: `http://${REGISTRY_SERVICE_NAME}.${namespace}.svc.cluster.local:${String(REGISTRY_PORT)}`,
    routerOrigin: `http://${ROUTER_SERVICE_NAME}.${namespace}.svc.cluster.local:${String(ROUTER_PORT)}`,
  });
}

/**
 * Project only the public network values an endpoint daemon needs.
 * @param authority Complete run-private authority to project.
 * @returns The public Registry and Router configuration for an endpoint.
 */
export function societyNetworkConfiguration(
  authority: SocietyNetworkAuthority,
): SocietyNetworkConfiguration {
  return Object.freeze({
    registryOrigin: authority.registryOrigin,
    routerOrigin: authority.routerOrigin,
    registrySignerPublicKeyJson: authority.registrySignerPublicKeyJson,
  });
}

/**
 * Mint one endpoint key and idempotent Registry registration identity.
 * @returns Private authority for one agent daemon and registrar.
 */
export function generateAgentDaemonAuthority(): AgentDaemonAuthority {
  return Object.freeze({
    privateKeyPem: privateKeyPem(),
    operationId: identifier(OperationId, "opn_"),
    principalId: identifier(PrincipalId, "prn_"),
  });
}

function identifier<Encoded extends string, Value extends string>(
  schema: Schema.Schema<Value, Encoded>,
  prefix: string,
): Value {
  return Schema.decodeUnknownSync(schema)(
    `${prefix}${randomBytes(IDENTIFIER_BYTES).toString("base64url")}`,
  );
}

function privateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}
