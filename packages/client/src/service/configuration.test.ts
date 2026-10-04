/** @file Exact process-input and secret-file tests for daemon bootstrap. */

import { AgentSigningAuthority } from "@moltzap/identity";
import { ConfigProvider, Effect, Redacted } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests create and remove exact temporary secret-file fixtures around the configuration boundary.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadDaemonBootstrap,
  loadDaemonProcessConfiguration,
} from "./configuration.js";
import type {
  DaemonConfigurationError,
  DaemonProcessConfiguration,
} from "./bootstrap.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/no-hardcoded-assertion-literals -- Exact keys, spellings, redaction, and closed reasons are the configuration contract under test. */

const privateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHsbmQdBGQFs1eXLEWxKDblLeG//B9s8WmWEMQHvw4f8
-----END PRIVATE KEY-----`;
const registrySigner =
  '{"crv":"Ed25519","kty":"OKP","x":"y1j1FUgbqjCPeQVEnllv-2euwn_s9DeDkfEh3gk_OJ0"}';
const directories: string[] = [];
const noOverrides = new Map<string, string>();
const EXPORT_PATH = "/var/run/moltzap/history.ndjson";

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
    new Map([["MOLTZAPD_ADMISSION_CREDENTIAL_FILE", "/run/\u0000admission"]]),
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
  const admissionCredential = await Effect.runPromise(
    bootstrap.admissionCredential,
  );
  expect(Redacted.isRedacted(admissionCredential)).toBe(true);
  expect(Redacted.value(admissionCredential)).toBe("bootstrap-token=");
};

const loadsBootstrapWithoutAdmissionFile = async () => {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "agent.pem"), privateKey);
  const configuration = await Effect.runPromise(loadConfiguration(directory));
  const bootstrap = await Effect.runPromise(loadDaemonBootstrap(configuration));
  expect(bootstrap.agentPublicKey.x).toBe(
    "3rUJ92tIP0DE4ekmET1zme6SIWTp5G0KiF3ZjL-AoKg",
  );
  expect(
    await Effect.runPromise(failureReason(bootstrap.admissionCredential)),
  ).toBe("admission-credential-file");
};

const treatsEmptyAdmissionFileAsUnset = async () => {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "agent.pem"), privateKey);
  const configuration = await Effect.runPromise(
    loadConfiguration(
      directory,
      new Map([["MOLTZAPD_ADMISSION_CREDENTIAL_FILE", ""]]),
    ),
  );
  expect(configuration.admissionCredentialFile).toBeUndefined();
  const bootstrap = await Effect.runPromise(loadDaemonBootstrap(configuration));
  expect(
    await Effect.runPromise(failureReason(bootstrap.admissionCredential)),
  ).toBe("admission-credential-file");
};

const loadsBootstrapWithAdmissionFileUnset = async () => {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "agent.pem"), privateKey);
  const configuration = await Effect.runPromise(
    loadDaemonProcessConfiguration.pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map(
            [...requiredConfiguration(directory)].filter(
              ([name]) => name !== "MOLTZAPD_ADMISSION_CREDENTIAL_FILE",
            ),
          ),
        ),
      ),
    ),
  );
  expect(configuration.admissionCredentialFile).toBeUndefined();
  const bootstrap = await Effect.runPromise(loadDaemonBootstrap(configuration));
  expect(
    await Effect.runPromise(failureReason(bootstrap.admissionCredential)),
  ).toBe("admission-credential-file");
};

const admissionFailureReason = async (
  configuration: DaemonProcessConfiguration,
) => {
  const bootstrap = await Effect.runPromise(loadDaemonBootstrap(configuration));
  return await Effect.runPromise(failureReason(bootstrap.admissionCredential));
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
  expect(await admissionFailureReason(configuration)).toBe(
    "admission-credential-file",
  );

  writeFileSync(join(directory, "admission"), "bootstrap-token=\n");
  expect(await admissionFailureReason(configuration)).toBe(
    "admission-credential",
  );

  writeFileSync(
    join(directory, "admission"),
    Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("bootstrap-token=")]),
  );
  expect(await admissionFailureReason(configuration)).toBe(
    "admission-credential",
  );
};

// @agent-code-guard/regression-only: these examples pin the daemon process inputs and exact secret-file boundary.
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
  it(
    "loads the bootstrap without reading a missing admission credential file",
    loadsBootstrapWithoutAdmissionFile,
  );
  it(
    "accepts an unset admission credential file until the credential is used",
    loadsBootstrapWithAdmissionFileUnset,
  );
  it(
    "treats an empty admission credential file setting as unset",
    treatsEmptyAdmissionFileAsUnset,
  );
});

describe("history export configuration", () => {
  it("leaves the export unset when the operator names no file", async () => {
    const directory = temporaryDirectory();
    const configuration = await Effect.runPromise(loadConfiguration(directory));
    expect(configuration.historyExport).toBeUndefined();
  });

  it("takes the export file the operator names", async () => {
    const directory = temporaryDirectory();
    const configuration = await Effect.runPromise(
      loadConfiguration(
        directory,
        new Map([["MOLTZAPD_HISTORY_EXPORT", EXPORT_PATH]]),
      ),
    );
    expect(configuration.historyExport).toBe(EXPORT_PATH);
  });

  it("refuses an empty export path rather than exporting nowhere", async () => {
    const directory = temporaryDirectory();
    expect(
      await Effect.runPromise(
        failureReason(
          loadConfiguration(
            directory,
            new Map([["MOLTZAPD_HISTORY_EXPORT", ""]]),
          ),
        ),
      ),
    ).toBe("environment");
  });
});

const runtimeToken = "runtime-for-local-test-0000000001";
const ownerToken = "owner-for-local-test-000000000001";
const credentialConfiguration = (directory: string) =>
  loadConfiguration(
    directory,
    new Map([
      ["MOLTZAPD_MCP_RUNTIME_CREDENTIAL_FILE", join(directory, "runtime")],
      ["MOLTZAPD_MCP_OWNER_CREDENTIAL_FILE", join(directory, "owner")],
    ]),
  );
const bootstrapFiles = () => {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "agent.pem"), privateKey);
  writeFileSync(join(directory, "admission"), "bootstrap-token=");
  return directory;
};
const loadsSeparatedAuthority = async () => {
  const directory = bootstrapFiles();
  writeFileSync(join(directory, "runtime"), runtimeToken);
  writeFileSync(join(directory, "owner"), ownerToken);
  const bootstrap = await Effect.runPromise(
    credentialConfiguration(directory).pipe(
      Effect.flatMap(loadDaemonBootstrap),
    ),
  );
  expect(bootstrap.mcpCredentials?.runtime).toEqual(
    Redacted.make(runtimeToken),
  );
  expect(bootstrap.mcpCredentials?.owner).toEqual(Redacted.make(ownerToken));
  expect(JSON.stringify(bootstrap.mcpCredentials)).not.toContain(runtimeToken);
  const local = await Effect.runPromise(
    loadConfiguration(directory).pipe(Effect.flatMap(loadDaemonBootstrap)),
  );
  expect(local.mcpCredentials).toBeUndefined();
};
const rejectsInvalidAuthority = async () => {
  const directory = bootstrapFiles();
  writeFileSync(join(directory, "owner"), ownerToken);
  for (const token of [
    "short",
    ownerToken,
    `${runtimeToken}\n`,
    `\ufeff${runtimeToken}`,
  ]) {
    writeFileSync(join(directory, "runtime"), token);
    expect(
      await Effect.runPromise(
        failureReason(
          credentialConfiguration(directory).pipe(
            Effect.flatMap(loadDaemonBootstrap),
          ),
        ),
      ),
    ).toBe("mcp-credential");
  }
  const partial = loadConfiguration(
    directory,
    new Map([
      ["MOLTZAPD_MCP_RUNTIME_CREDENTIAL_FILE", join(directory, "runtime")],
    ]),
  );
  expect(
    await Effect.runPromise(
      failureReason(partial.pipe(Effect.flatMap(loadDaemonBootstrap))),
    ),
  ).toBe("mcp-credential");
};
const rejectsMissingAuthority = async () => {
  const directory = bootstrapFiles();
  const bootstrap = credentialConfiguration(directory).pipe(
    Effect.flatMap(loadDaemonBootstrap),
  );
  expect(await Effect.runPromise(failureReason(bootstrap))).toBe(
    "mcp-runtime-credential-file",
  );
  writeFileSync(join(directory, "runtime"), runtimeToken);
  expect(await Effect.runPromise(failureReason(bootstrap))).toBe(
    "mcp-owner-credential-file",
  );
};
// @agent-code-guard/regression-only: exact file bytes and distinct roles are the tunnel authority boundary.
describe("MCP credential configuration", () => {
  it(
    "loads distinct redacted credentials and retains trusted-local default",
    loadsSeparatedAuthority,
  );
  it(
    "rejects partial, shared, short or noncanonical credentials",
    rejectsInvalidAuthority,
  );
  it(
    "preserves closed credential file failure categories",
    rejectsMissingAuthority,
  );
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
