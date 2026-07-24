import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMoltZapAgentServiceSocketPath,
  getMoltZapServiceSocketPath,
} from "./local-paths.js";
import { FakeMoltZapService } from "./test-utils/fake-service.js";

const scopedIt = effectIt.scoped;

const SAFE_AGENT_ID = "agent-abc_123";
const DEFAULT_SOCKET_SEGMENT = "default";
const SAFE_SOCKET_NAME = "service-agent-abc_123.sock";
const DEFAULT_SOCKET_NAME = "service-default.sock";
const DISCOVERY_SOCKET_NAME = "service.sock";
const ETC_PASSWD_SEGMENT = "etc/passwd";
const CONFIG_HOME_PREFIX = "moltzap-socket-config-";
const OPERATOR_HOME_PREFIX = "moltzap-socket-operator-";
const EXPECTED_DEFAULT_SOCKET_PATH = getMoltZapAgentServiceSocketPath(
  DEFAULT_SOCKET_SEGMENT,
);
const EXPECTED_SAFE_SOCKET_PATH =
  getMoltZapAgentServiceSocketPath(SAFE_AGENT_ID);
const MOLTZAP_SOCKET_DIR = EXPECTED_DEFAULT_SOCKET_PATH.slice(
  0,
  -DEFAULT_SOCKET_NAME.length,
);

function setOwnAgentId(service: FakeMoltZapService, id: string): void {
  Reflect.set(service, "_ownAgentId", id);
}

function socketPathAcceptsSafeAgentIds() {
  const service = new FakeMoltZapService();
  setOwnAgentId(service, SAFE_AGENT_ID);
  expect(service.socketPath).toBe(EXPECTED_SAFE_SOCKET_PATH);
  expect(service.socketPath.endsWith(SAFE_SOCKET_NAME)).toBe(true);
}

function socketPathRejectsTraversal() {
  const service = new FakeMoltZapService();
  setOwnAgentId(service, "../etc/passwd");
  expect(service.socketPath).toBe(EXPECTED_DEFAULT_SOCKET_PATH);
  expect(service.socketPath).not.toContain("..");
  expect(service.socketPath).not.toContain(ETC_PASSWD_SEGMENT);
}

function socketPathRejectsForwardSlash() {
  const service = new FakeMoltZapService();
  setOwnAgentId(service, "foo/bar");
  expect(service.socketPath).toBe(EXPECTED_DEFAULT_SOCKET_PATH);
}

function socketPathRejectsParentSegment() {
  const service = new FakeMoltZapService();
  setOwnAgentId(service, "..");
  expect(service.socketPath).toBe(EXPECTED_DEFAULT_SOCKET_PATH);
}

function socketPathRejectsEmptyAndWhitespace() {
  const service = new FakeMoltZapService();
  setOwnAgentId(service, "");
  expect(service.socketPath).toBe(EXPECTED_DEFAULT_SOCKET_PATH);

  setOwnAgentId(service, " ");
  expect(service.socketPath).toBe(EXPECTED_DEFAULT_SOCKET_PATH);
}

function socketPathRejectsPunctuation() {
  const service = new FakeMoltZapService();
  for (const bad of [
    "a;b",
    "a|b",
    "a$b",
    "a\\b",
    "a\nb",
    ".hidden",
    "foo.sock",
  ]) {
    setOwnAgentId(service, bad);
    expect(service.socketPath).toBe(EXPECTED_DEFAULT_SOCKET_PATH);
  }
}

function socketPathDefaultsBeforeAgentAssignment() {
  const service = new FakeMoltZapService();
  // The fake seeds a constructor `agentId`; clear it to model the genuine
  // pre-registration state where `ownAgentId` is still undefined, so the path
  // falls back to `default`.
  Reflect.set(service, "_ownAgentId", undefined);
  expect(service.socketPath).toBe(EXPECTED_DEFAULT_SOCKET_PATH);
}

function rejectedSocketPathsStayInMoltzapDir() {
  const service = new FakeMoltZapService();
  for (const bad of ["../foo", "a/b", "a\x00b", "a\\b"]) {
    setOwnAgentId(service, bad);
    expect(service.socketPath.startsWith(MOLTZAP_SOCKET_DIR)).toBe(true);
  }
}

function socketPathsFollowConfigHome() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configHome = yield* fileSystem.makeTempDirectoryScoped({
      prefix: CONFIG_HOME_PREFIX,
    });
    const operatorHome = yield* fileSystem.makeTempDirectoryScoped({
      prefix: OPERATOR_HOME_PREFIX,
    });
    vi.stubEnv("HOME", operatorHome);
    vi.stubEnv("MOLTZAP_CONFIG_HOME", configHome);

    const service = new FakeMoltZapService();
    setOwnAgentId(service, SAFE_AGENT_ID);

    expect(service.socketPath).toBe(path.join(configHome, SAFE_SOCKET_NAME));
    expect(getMoltZapServiceSocketPath()).toBe(
      path.join(configHome, DISCOVERY_SOCKET_NAME),
    );
  }).pipe(Effect.provide(NodeContext.layer));
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MoltZapService.socketPath safe ids", () => {
  it(
    "accepts safe alphanumeric agent ids verbatim",
    socketPathAcceptsSafeAgentIds,
  );
});

describe("MoltZapService.socketPath rejected ids", () => {
  it(
    "rejects `..` traversal and falls back to `service-default.sock`",
    socketPathRejectsTraversal,
  );

  it("rejects forward-slash separators", socketPathRejectsForwardSlash);

  it("rejects a plain `..` agent id", socketPathRejectsParentSegment);
});

describe("MoltZapService.socketPath fallback ids", () => {
  it(
    "rejects empty-string and whitespace agent ids",
    socketPathRejectsEmptyAndWhitespace,
  );

  it(
    "rejects shell metacharacters and path-like punctuation",
    socketPathRejectsPunctuation,
  );

  it(
    "falls back to `default` when no agent id has been assigned yet",
    socketPathDefaultsBeforeAgentAssignment,
  );
});

describe("MoltZapService.socketPath containment", () => {
  it(
    "keeps the socket inside the configured MoltZap directory",
    rejectedSocketPathsStayInMoltzapDir,
  );

  scopedIt(
    "uses MOLTZAP_CONFIG_HOME for agent and discovery sockets",
    socketPathsFollowConfigHome,
  );
});
