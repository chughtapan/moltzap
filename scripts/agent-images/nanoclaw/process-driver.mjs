/** @file In-process NanoClaw session driver for the complete agent image. */
import { spawn as spawnChild } from "node:child_process";
import {
  lstat,
  mkdir,
  readlink,
  readdir,
  realpath,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export const PROCESS_DRIVER_KIND = "moltzap-process";

const CAPABILITIES = Object.freeze({
  isolationTiers: Object.freeze(["container"]),
  admissionEnforced: false,
  networkPolicy: "topology",
  encryptedVolumes: false,
  unrealized: Object.freeze(["memoryMb", "cpus", "pidsLimit", "shmSizeMb"]),
  sharedNetworkNamespace: true,
  auxiliaryContainers: false,
  imageBuild: false,
});

function sameKey(left, right) {
  return (
    left.installSlug === right.installSlug &&
    left.agentGroupId === right.agentGroupId &&
    left.sessionId === right.sessionId
  );
}

function keyText(key) {
  return `${key.installSlug}/${key.agentGroupId}/${key.sessionId}`;
}

function snapshot(record) {
  const phase =
    record.status.phase === "running"
      ? "running"
      : record.status.phase === "ready" || record.status.phase === "preparing"
        ? "starting"
        : "terminal";
  return {
    handle: record.handle,
    phase,
    ...(record.status.phase === "failed"
      ? { failure: record.status.failure }
      : {}),
  };
}

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function resolvesTo(path, source) {
  try {
    return (await realpath(path)) === (await realpath(source));
  } catch {
    const info = await exists(path);
    if (!info?.isSymbolicLink()) return false;
    const target = await readlink(path);
    return resolve(dirname(path), target) === resolve(source);
  }
}

async function replaceWithSymlink(path, source, specInvalid) {
  if (!isAbsolute(path) || !isAbsolute(source)) {
    throw specInvalid(
      `process-driver mounts must use absolute paths: ${source} -> ${path}`,
    );
  }
  if (!(await exists(source))) {
    throw specInvalid(`process-driver mount source does not exist: ${source}`);
  }
  if (await resolvesTo(path, source)) return;

  const info = await exists(path);
  if (info?.isSymbolicLink()) {
    await unlink(path);
  } else if (info?.isDirectory()) {
    if ((await readdir(path)).length > 0) {
      throw specInvalid(
        `process-driver refuses to replace non-empty mount target ${path}`,
      );
    }
    await rmdir(path);
  } else if (info !== undefined) {
    throw specInvalid(`process-driver refuses to replace mount target ${path}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await symlink(
    source,
    path,
    (await lstat(source)).isDirectory() ? "dir" : "file",
  );
}

/**
 * Project a validated container mount list into the already-isolated outer
 * application container. The shallowest target is linked first so nested
 * mounts are resolved inside the selected session workspace.
 */
export async function materializeProcessMounts(
  mounts,
  {
    resolveContainerPath = (path) => path,
    specInvalid = (detail) => new Error(detail),
  } = {},
) {
  const ordered = [...mounts].sort(
    (left, right) => left.containerPath.length - right.containerPath.length,
  );
  for (const mount of ordered) {
    const target = resolveContainerPath(mount.containerPath);
    if (!isAbsolute(target)) {
      throw specInvalid(
        `process-driver resolved a relative mount target: ${target}`,
      );
    }
    await replaceWithSymlink(target, mount.hostPath, specInvalid);
  }
}

function killProcessGroup(processId, signal) {
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function waitForExit(record, timeoutMillis) {
  if (record.child?.exitCode !== null || record.child?.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMillis);
    timer.unref?.();
    record.child?.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

/** Create the single-session process realization used inside one app pod. */
export function createProcessSessionDriver({
  policy,
  validateSpec,
  specInvalid,
  spawn = spawnChild,
  resolveContainerPath = (path) => path,
  workingDirectory = "/workspace/agent",
  baseEnvironment = {
    HOME: "/home/node",
    NODE_ENV: "production",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  },
}) {
  let boundKey;
  let record;
  const watchers = new Map();

  function emit(kind = "phase") {
    if (record === undefined) return;
    const event = { key: record.spec.key, kind };
    for (const watcher of watchers.values()) watcher(event);
  }

  function makeHandle(nextRecord) {
    return Object.freeze({
      key: nextRecord.spec.key,
      name: `moltzap-process-${nextRecord.spec.key.agentGroupId}`,
      async start() {
        await nextRecord.ready;
        if (nextRecord.status.phase === "running") return;
        if (nextRecord.status.phase !== "ready") {
          throw specInvalid(
            `cannot start ${keyText(nextRecord.spec.key)} from ${nextRecord.status.phase}`,
          );
        }
        const agent = nextRecord.spec.containers[0];
        const command = agent.command ?? [];
        if (command.length === 0) {
          throw specInvalid("agent container has no command");
        }
        const child = spawn(
          command[0],
          [...command.slice(1), ...(agent.args ?? [])],
          {
            cwd: resolveContainerPath(workingDirectory),
            detached: true,
            env: {
              ...baseEnvironment,
              ...agent.env,
              ...(agent.contributedEnv ?? {}),
            },
            stdio: "inherit",
            ...(nextRecord.spec.runAs === undefined
              ? {}
              : {
                  uid: nextRecord.spec.runAs.uid,
                  gid: nextRecord.spec.runAs.gid,
                }),
          },
        );
        nextRecord.child = child;
        nextRecord.status = { phase: "running" };
        emit();
        child.once("error", (error) => {
          if (nextRecord.status.phase !== "running") return;
          nextRecord.status = {
            phase: "failed",
            failure: {
              kind: "unknown",
              retryable: false,
              opaqueRef: error.message,
            },
          };
          emit("terminal");
        });
        child.once("exit", (exitCode) => {
          if (nextRecord.stopping) {
            nextRecord.status = { phase: "stopped" };
          } else {
            nextRecord.status = {
              phase: "failed",
              failure: {
                kind: "started-then-died",
                retryable: false,
                ...(exitCode === null ? {} : { exitCode }),
              },
            };
          }
          emit("terminal");
        });
      },
      async status() {
        await nextRecord.ready;
        return nextRecord.status;
      },
      async stop() {
        await nextRecord.ready;
        if (nextRecord.status.phase === "stopped") return;
        if (nextRecord.status.phase === "failed") {
          nextRecord.status = { phase: "stopped" };
          emit("terminal");
          return;
        }
        if (nextRecord.status.phase === "ready") {
          nextRecord.status = { phase: "stopped" };
          emit("terminal");
          return;
        }
        const child = nextRecord.child;
        if (child?.pid === undefined) {
          nextRecord.status = { phase: "stopped" };
          emit("terminal");
          return;
        }
        nextRecord.stopping = true;
        killProcessGroup(child.pid, "SIGTERM");
        const graceMillis = nextRecord.spec.stopGraceSeconds * 1_000;
        if (!(await waitForExit(nextRecord, graceMillis))) {
          killProcessGroup(child.pid, "SIGKILL");
          await waitForExit(nextRecord, 1_000);
        }
        nextRecord.status = { phase: "stopped" };
        emit("terminal");
      },
      execSpec() {
        throw specInvalid(
          "interactive attach is unavailable in the NanoClaw simulator process driver",
        );
      },
    });
  }

  return Object.freeze({
    kind: PROCESS_DRIVER_KIND,
    capabilities() {
      return CAPABILITIES;
    },
    async ensureReady() {},
    async prepare(spec) {
      validateSpec(spec, policy, CAPABILITIES);
      if (
        spec.containers.length !== 1 ||
        spec.containers[0]?.role !== "agent"
      ) {
        throw specInvalid(
          "process driver accepts exactly one agent container and no auxiliaries",
        );
      }
      if (boundKey !== undefined && !sameKey(boundKey, spec.key)) {
        throw specInvalid(
          `one app container is already bound to ${keyText(boundKey)}; refused ${keyText(spec.key)}`,
        );
      }
      boundKey ??= spec.key;
      if (
        record !== undefined &&
        sameKey(record.spec.key, spec.key) &&
        record.status.phase !== "stopped" &&
        record.status.phase !== "failed"
      ) {
        await record.ready;
        return record.handle;
      }

      const nextRecord = {
        spec,
        child: undefined,
        stopping: false,
        status: { phase: "preparing" },
        ready: undefined,
        handle: undefined,
      };
      nextRecord.handle = makeHandle(nextRecord);
      nextRecord.ready = materializeProcessMounts(spec.containers[0].mounts, {
        resolveContainerPath,
        specInvalid,
      })
        .then(() => {
          nextRecord.status = { phase: "ready" };
          emit();
        })
        .catch((error) => {
          nextRecord.status = {
            phase: "failed",
            failure: {
              kind: "spec-invalid",
              retryable: false,
              detail: error instanceof Error ? error.message : String(error),
            },
          };
          throw error;
        });
      record = nextRecord;
      await nextRecord.ready;
      return nextRecord.handle;
    },
    async listSessions(installSlug) {
      return record !== undefined && record.spec.key.installSlug === installSlug
        ? [snapshot(record)]
        : [];
    },
    watchSessions(installSlug, onEvent) {
      const token = Symbol(installSlug);
      watchers.set(token, (event) => {
        if (event.key.installSlug === installSlug) onEvent(event);
      });
      return Object.freeze({ stop: () => watchers.delete(token) });
    },
  });
}

/** Register the process driver through NanoClaw's public driver seam. */
export function installProcessSessionDriver(dependencies) {
  const stateDirectory =
    process.env.MOLTZAP_NANOCLAW_STATE ?? "/var/lib/moltzap/nanoclaw";
  const resolveContainerPath = (path) => {
    if (path === "/workspace") {
      return `${stateDirectory}/current-workspace`;
    }
    if (path === "/app/.nanoclaw-session.json") {
      return `${stateDirectory}/current-session-context`;
    }
    return path;
  };
  dependencies.registerSessionDriver(PROCESS_DRIVER_KIND, (policy) =>
    createProcessSessionDriver({
      policy,
      validateSpec: dependencies.validateSpec,
      specInvalid: dependencies.specInvalid,
      resolveContainerPath,
    }),
  );
}
