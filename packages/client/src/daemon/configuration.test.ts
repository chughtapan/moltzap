/** @file Exact process-input and secret-file tests for daemon bootstrap. */

import { AgentSigningAuthority } from "@moltzap/identity";
import { ConfigProvider, Effect, Redacted } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests create and remove exact temporary secret-file fixtures around the configuration boundary.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DaemonConfigurationError,
  loadDaemonBootstrap,
  loadDaemonProcessConfiguration,
} from "./configuration.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/no-hardcoded-assertion-literals -- Exact keys, spellings, redaction, and closed reasons are the configuration contract under test. */

const privateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHsbmQdBGQFs1eXLEWxKDblLeG//B9s8WmWEMQHvw4f8
-----END PRIVATE KEY-----`;
const registrySigner =
  '{"crv":"Ed25519","kty":"OKP","x":"y1j1FUgbqjCPeQVEnllv-2euwn_s9DeDkfEh3gk_OJ0"}';
const directories: string[] = [];
const noOverrides = new Map<string, string>();

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "moltzap-daemon-config-"));
  directories.push(directory);
  return directory;
};

const requiredConfiguration = (directory: string) =>
  new Map([
    ["MOLTZAPD_STATE_DIRECTORY", join(directory, "state")],
    ["MOLTZAPD_MCP_PORT", "4319"],
    ["MOLTZAPD_REGISTRY_ORIGIN", "https://registry.example"],
    ["MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY", registrySigner],
    ["MOLTZAPD_ROUTER_ORIGIN", "http://router.example:4320"],
    ["MOLTZAPD_AGENT_PRIVATE_KEY_FILE", join(directory, "agent.pem")],
    ["MOLTZAPD_ADMISSION_CREDENTIAL_FILE", join(directory, "admission")],
  ]);

const loadConfiguration = (
  directory: string,
  overrides: ReadonlyMap<string, string> = noOverrides,
) =>
  loadDaemonProcessConfiguration.pipe(
    Effect.withConfigProvider(
      ConfigProvider.fromMap(
        new Map([
          ...requiredConfiguration(directory),
          ["UNRELATED_DEPLOYMENT_VALUE", "ignored"],
          ...overrides,
        ]),
      ),
    ),
  );

const failureReason = <A>(effect: Effect.Effect<A, DaemonConfigurationError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const loadsExactConfiguration = async () => {
  const directory = temporaryDirectory();
  const configuration = await Effect.runPromise(loadConfiguration(directory));
  expect(configuration).toMatchObject({
    stateDirectory: join(directory, "state"),
    mcpPort: 4319,
  });
  expect(configuration.registryOrigin.href).toBe("https://registry.example/");
  expect(configuration.routerOrigin.href).toBe("http://router.example:4320/");
  expect(configuration.registrySignerPublicKey.x).toBe(
    "y1j1FUgbqjCPeQVEnllv-2euwn_s9DeDkfEh3gk_OJ0",
  );
  expect(Redacted.isRedacted(configuration.agentPrivateKeyFile)).toBe(true);
  expect(Redacted.isRedacted(configuration.admissionCredentialFile)).toBe(true);
};

const rejectsInvalidEnvironment = async () => {
  const directory = temporaryDirectory();
  const invalidOverrides = [
    new Map([["MOLTZAPD_STATE_DIRECTORY", ""]]),
    new Map([["MOLTZAPD_MCP_PORT", "0"]]),
    new Map([["MOLTZAPD_MCP_PORT", "01"]]),
    new Map([["MOLTZAPD_MCP_PORT", "65536"]]),
    new Map([["MOLTZAPD_REGISTRY_ORIGIN", "https://registry.example/path"]]),
    new Map([["MOLTZAPD_ROUTER_ORIGIN", "ftp://router.example"]]),
    new Map([["MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY", `${registrySigner} `]]),
  ];
  for (const overrides of invalidOverrides) {
    expect(
      await Effect.runPromise(
        failureReason(loadConfiguration(directory, overrides)),
      ),
    ).toBe("environment");
  }
};

const loadsExactRedactedSecrets = async () => {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "agent.pem"), privateKey);
  writeFileSync(join(directory, "admission"), "bootstrap-token=");
  const configuration = await Effect.runPromise(loadConfiguration(directory));
  const bootstrap = await Effect.runPromise(loadDaemonBootstrap(configuration));
  expect(bootstrap.agentPublicKey.x).toBe(
    AgentSigningAuthority.publicKey(bootstrap.signingAuthority).x,
  );
  expect(bootstrap.agentPublicKey.x).toBe(
    "3rUJ92tIP0DE4ekmET1zme6SIWTp5G0KiF3ZjL-AoKg",
  );
  expect(Redacted.isRedacted(bootstrap.admissionCredential)).toBe(true);
  expect(Redacted.value(bootstrap.admissionCredential)).toBe(
    "bootstrap-token=",
  );
};

const rejectsSecretFileFailures = async () => {
  const directory = temporaryDirectory();
  const configuration = await Effect.runPromise(loadConfiguration(directory));
  expect(
    await Effect.runPromise(failureReason(loadDaemonBootstrap(configuration))),
  ).toBe("agent-private-key-file");

  writeFileSync(join(directory, "agent.pem"), "not a private key");
  expect(
    await Effect.runPromise(failureReason(loadDaemonBootstrap(configuration))),
  ).toBe("agent-private-key");

  writeFileSync(join(directory, "agent.pem"), privateKey);
  expect(
    await Effect.runPromise(failureReason(loadDaemonBootstrap(configuration))),
  ).toBe("admission-credential-file");

  writeFileSync(join(directory, "admission"), "bootstrap-token=\n");
  expect(
    await Effect.runPromise(failureReason(loadDaemonBootstrap(configuration))),
  ).toBe("admission-credential");

  writeFileSync(
    join(directory, "admission"),
    Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("bootstrap-token=")]),
  );
  expect(
    await Effect.runPromise(failureReason(loadDaemonBootstrap(configuration))),
  ).toBe("admission-credential");
};

// @agent-code-guard/regression-only: these examples pin the seven-input daemon configuration and exact secret-file boundary.
describe("daemon configuration", () => {
  it(
    "loads exactly the declared configuration and ignores unrelated values",
    loadsExactConfiguration,
  );
  it(
    "rejects alternate process-input spellings and ranges",
    rejectsInvalidEnvironment,
  );
  it(
    "loads the unmodified private key and redacted admission credential",
    loadsExactRedactedSecrets,
  );
  it(
    "closes file, UTF-8, key, and credential failures",
    rejectsSecretFileFailures,
  );
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
