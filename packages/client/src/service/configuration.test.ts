/** @file Exact process-input and secret-file tests for daemon bootstrap. */

import { live as it } from "@effect/vitest";
import { AgentSigningAuthority } from "@moltzap/identity";
import { ConfigProvider, Effect, Redacted } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests create and remove exact temporary secret-file fixtures around the configuration boundary.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import type {
  DaemonConfigurationError,
  DaemonProcessConfiguration,
} from "./bootstrap.js";
import {
  loadDaemonBootstrap,
  loadDaemonProcessConfiguration,
} from "./configuration.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Exact keys, spellings, redaction, and closed reasons are the configuration contract under test. */

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

const loadsExactConfiguration = () =>
  Effect.gen(function* () {
    const directory = temporaryDirectory();
    const configuration = yield* loadConfiguration(directory);
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
    expect(Redacted.isRedacted(configuration.admissionCredentialFile)).toBe(
      true,
    );
  });

const rejectsInvalidEnvironment = () =>
  Effect.gen(function* () {
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
        yield* failureReason(loadConfiguration(directory, overrides)),
      ).toBe("environment");
    }
  });

const loadsExactRedactedSecrets = () =>
  Effect.gen(function* () {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "agent.pem"), privateKey);
    writeFileSync(join(directory, "admission"), "bootstrap-token=");
    const configuration = yield* loadConfiguration(directory);
    const bootstrap = yield* loadDaemonBootstrap(configuration);
    expect(bootstrap.agentPublicKey.x).toBe(
      AgentSigningAuthority.publicKey(bootstrap.signingAuthority).x,
    );
    expect(bootstrap.agentPublicKey.x).toBe(
      "3rUJ92tIP0DE4ekmET1zme6SIWTp5G0KiF3ZjL-AoKg",
    );
    const admissionCredential = yield* bootstrap.admissionCredential;
    expect(Redacted.isRedacted(admissionCredential)).toBe(true);
    expect(Redacted.value(admissionCredential)).toBe("bootstrap-token=");
  });

const loadsBootstrapWithoutAdmissionFile = () =>
  Effect.gen(function* () {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "agent.pem"), privateKey);
    const configuration = yield* loadConfiguration(directory);
    const bootstrap = yield* loadDaemonBootstrap(configuration);
    expect(bootstrap.agentPublicKey.x).toBe(
      "3rUJ92tIP0DE4ekmET1zme6SIWTp5G0KiF3ZjL-AoKg",
    );
    expect(yield* failureReason(bootstrap.admissionCredential)).toBe(
      "admission-credential-file",
    );
  });

const treatsEmptyAdmissionFileAsUnset = () =>
  Effect.gen(function* () {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "agent.pem"), privateKey);
    const configuration = yield* loadConfiguration(
      directory,
      new Map([["MOLTZAPD_ADMISSION_CREDENTIAL_FILE", ""]]),
    );
    expect(configuration.admissionCredentialFile).toBeUndefined();
    const bootstrap = yield* loadDaemonBootstrap(configuration);
    expect(yield* failureReason(bootstrap.admissionCredential)).toBe(
      "admission-credential-file",
    );
  });

const loadsBootstrapWithAdmissionFileUnset = () =>
  Effect.gen(function* () {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "agent.pem"), privateKey);
    const configuration = yield* loadDaemonProcessConfiguration.pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map(
            [...requiredConfiguration(directory)].filter(
              ([name]) => name !== "MOLTZAPD_ADMISSION_CREDENTIAL_FILE",
            ),
          ),
        ),
      ),
    );
    expect(configuration.admissionCredentialFile).toBeUndefined();
    const bootstrap = yield* loadDaemonBootstrap(configuration);
    expect(yield* failureReason(bootstrap.admissionCredential)).toBe(
      "admission-credential-file",
    );
  });

const admissionFailureReason = (configuration: DaemonProcessConfiguration) =>
  Effect.gen(function* () {
    const bootstrap = yield* loadDaemonBootstrap(configuration);
    return yield* failureReason(bootstrap.admissionCredential);
  });

const rejectsSecretFileFailures = () =>
  Effect.gen(function* () {
    const directory = temporaryDirectory();
    const configuration = yield* loadConfiguration(directory);
    expect(yield* failureReason(loadDaemonBootstrap(configuration))).toBe(
      "agent-private-key-file",
    );

    writeFileSync(join(directory, "agent.pem"), "not a private key");
    expect(yield* failureReason(loadDaemonBootstrap(configuration))).toBe(
      "agent-private-key",
    );

    writeFileSync(join(directory, "agent.pem"), privateKey);
    writeFileSync(join(directory, "admission"), "bootstrap-token=\n");
    expect(yield* admissionFailureReason(configuration)).toBe(
      "admission-credential",
    );

    writeFileSync(
      join(directory, "admission"),
      Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("bootstrap-token=")]),
    );
    expect(yield* admissionFailureReason(configuration)).toBe(
      "admission-credential",
    );
  });

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
  it("leaves the export unset when the operator names no file", () =>
    Effect.gen(function* () {
      const directory = temporaryDirectory();
      const configuration = yield* loadConfiguration(directory);
      expect(configuration.historyExport).toBeUndefined();
    }));

  it("takes the export file the operator names", () =>
    Effect.gen(function* () {
      const directory = temporaryDirectory();
      const configuration = yield* loadConfiguration(
        directory,
        new Map([["MOLTZAPD_HISTORY_EXPORT", EXPORT_PATH]]),
      );
      expect(configuration.historyExport).toBe(EXPORT_PATH);
    }));

  it("refuses an empty export path rather than exporting nowhere", () =>
    Effect.gen(function* () {
      const directory = temporaryDirectory();
      expect(
        yield* failureReason(
          loadConfiguration(
            directory,
            new Map([["MOLTZAPD_HISTORY_EXPORT", ""]]),
          ),
        ),
      ).toBe("environment");
    }));
});

const runtimeToken = "runtime-for-local-test-0000000001";
const credentialConfiguration = (directory: string) =>
  loadConfiguration(
    directory,
    new Map([
      ["MOLTZAPD_MCP_RUNTIME_CREDENTIAL_FILE", join(directory, "runtime")],
      [
        "MOLTZAPD_MCP_MANAGEMENT_SOCKET",
        join(directory, "management", "mcp.sock"),
      ],
    ]),
  );
const bootstrapFiles = () => {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "agent.pem"), privateKey);
  writeFileSync(join(directory, "admission"), "bootstrap-token=");
  return directory;
};
const loadsSeparatedAuthority = () =>
  Effect.gen(function* () {
    const directory = bootstrapFiles();
    writeFileSync(join(directory, "runtime"), runtimeToken);
    const bootstrap = yield* credentialConfiguration(directory).pipe(
      Effect.flatMap(loadDaemonBootstrap),
    );
    expect(bootstrap.mcpCredentials?.runtime).toEqual(
      Redacted.make(runtimeToken),
    );
    expect(Object.keys(bootstrap.mcpCredentials ?? {})).toEqual(["runtime"]);
    expect(bootstrap.configuration.mcpManagementSocket).toBe(
      join(directory, "management", "mcp.sock"),
    );
    expect(JSON.stringify(bootstrap.mcpCredentials)).not.toContain(
      runtimeToken,
    );
    const local = yield* loadConfiguration(directory).pipe(
      Effect.flatMap(loadDaemonBootstrap),
    );
    expect(local.mcpCredentials).toBeUndefined();
  });
const rejectsInvalidAuthority = () =>
  Effect.gen(function* () {
    const directory = bootstrapFiles();
    for (const token of [
      "short",
      `${runtimeToken}\n`,
      `\ufeff${runtimeToken}`,
    ]) {
      writeFileSync(join(directory, "runtime"), token);
      expect(
        yield* failureReason(
          credentialConfiguration(directory).pipe(
            Effect.flatMap(loadDaemonBootstrap),
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
      yield* failureReason(partial.pipe(Effect.flatMap(loadDaemonBootstrap))),
    ).toBe("mcp-management-socket");
    const socketOnly = loadConfiguration(
      directory,
      new Map([
        ["MOLTZAPD_MCP_MANAGEMENT_SOCKET", join(directory, "mcp.sock")],
      ]),
    );
    expect(yield* failureReason(socketOnly)).toBe("mcp-management-socket");
  });
const rejectsMissingAuthority = () =>
  Effect.gen(function* () {
    const directory = bootstrapFiles();
    const bootstrap = credentialConfiguration(directory).pipe(
      Effect.flatMap(loadDaemonBootstrap),
    );
    expect(yield* failureReason(bootstrap)).toBe("mcp-runtime-credential-file");
  });
// @agent-code-guard/regression-only: exact file bytes and paired private management are the remote authority boundary.
describe("MCP credential configuration", () => {
  it(
    "loads one redacted runtime credential and retains trusted-local default",
    loadsSeparatedAuthority,
  );
  it(
    "rejects partial remote configuration and short or noncanonical credentials",
    rejectsInvalidAuthority,
  );
  it(
    "preserves closed credential file failure categories",
    rejectsMissingAuthority,
  );
  it.each(["", "/run/retired-owner"])(
    "rejects the obsolete owner setting even when its value is %j",
    (value) =>
      Effect.gen(function* () {
        const directory = bootstrapFiles();
        const configured = loadConfiguration(
          directory,
          new Map([["MOLTZAPD_MCP_OWNER_CREDENTIAL_FILE", value]]),
        );
        expect(yield* failureReason(configured)).toBe(
          "obsolete-mcp-owner-credential",
        );
      }),
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
