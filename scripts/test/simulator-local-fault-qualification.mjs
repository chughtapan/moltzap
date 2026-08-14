/** @file Runs and validates the workspace-owned local Simulator fault qualification. */

import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompletedLedgerReceipt,
  coreEvents,
  LinkPolicyCleared,
  LinkPolicySet,
  ProgramFailed,
  ProgramInterrupted,
  ProgramSucceeded,
} from "../../packages/simulator/dist/index.js";
import {
  ledgerRef,
  openLedgerArtifacts,
} from "../../packages/simulator/dist/ledger/index.js";
import { Effect, Schema, Stream } from "effect";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = dirname(dirname(scriptRoot));
const localProfile = join(
  workspaceRoot,
  "packages",
  "simulator",
  "dist",
  "cluster",
  "profiles",
  "local.js",
);
const localClusterCreator = join(
  workspaceRoot,
  "packages",
  "simulator",
  "scripts",
  "local-create-cluster.mjs",
);
const scenario = join(scriptRoot, "simulator-fault-end-to-end.mjs");
const DEFINITION_ID = "moltzap.fault-end-to-end/v1";
const MAX_SUBMISSION_OUTPUT_BYTES = 1024 * 1024;
const SAFE_PATH_SEGMENT = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;
const PINNED_IMAGE = /^.+@sha256:[0-9a-f]{64}$/u;

function requireCondition(condition, detail) {
  if (!condition) {
    throw new Error(detail);
  }
}

function record(value, label) {
  requireCondition(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function nonemptyString(value, label) {
  requireCondition(
    typeof value === "string" && value.length > 0,
    `${label} must be a nonempty string`,
  );
  return value;
}

function safePathSegment(value, label) {
  const segment = nonemptyString(value, label);
  requireCondition(
    SAFE_PATH_SEGMENT.test(segment),
    `${label} was not a safe path segment`,
  );
  return segment;
}

function parseFinalJsonLine(output, label) {
  const lines = output.split(/\r?\n/u).filter((line) => line.length > 0);
  const encoded = lines.at(-1);
  requireCondition(encoded !== undefined, `${label} returned no result`);

  try {
    return JSON.parse(encoded);
  } catch (cause) {
    throw new Error(`${label} returned an invalid JSON result`, {
      cause,
    });
  }
}

export function parseSubmission(output) {
  const decoded = parseFinalJsonLine(output, "local profile");

  const submission = record(decoded, "RunSubmission");
  const runId = safePathSegment(submission.runId, "RunSubmission.runId");
  const namespace = safePathSegment(
    submission.namespace,
    "RunSubmission.namespace",
  );
  requireCondition(
    namespace === runId && /^mz-[0-9a-f]{32}$/u.test(namespace),
    "RunSubmission identity did not match the local profile contract",
  );

  const result = record(submission.result, "RunSubmission.result");
  requireCondition(
    result.exitCode === 0,
    "local profile reported an unsuccessful controller process",
  );
  const summary = record(result.summary, "RunSubmission.result.summary");
  requireCondition(
    summary._tag === "ProgramFinished",
    "local profile did not report ProgramFinished",
  );
  const receipt = Schema.decodeUnknownSync(CompletedLedgerReceipt)(
    summary.receipt,
    { onExcessProperty: "error" },
  );
  return { runId, namespace, receipt };
}

function runCaptured(command, args, options, label, echoOutput = false) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["inherit", "pipe", "inherit"],
    });
    const chunks = [];
    let bytes = 0;
    let outputFailure;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (echoOutput) {
        process.stdout.write(chunk);
      }
      chunks.push(chunk);
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_SUBMISSION_OUTPUT_BYTES && outputFailure === undefined) {
        outputFailure = new Error(`${label} output exceeded 1 MiB`);
        child.kill("SIGTERM");
      }
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (outputFailure !== undefined) {
        rejectRun(outputFailure);
      } else if (code !== 0) {
        rejectRun(
          new Error(
            `${label} stopped with ${signal ?? `exit ${String(code)}`}`,
          ),
        );
      } else {
        resolveRun(chunks.join(""));
      }
    });
  });
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    requireCondition(
      value !== undefined,
      `${flag ?? "argument"} needs a value`,
    );
    if (flag === "--cluster") {
      options.cluster = value;
    } else if (flag === "--temporal-port") {
      options.temporalPort = Number(value);
    } else if (flag === "--artifacts") {
      options.artifacts = resolve(nonemptyString(value, "--artifacts"));
    } else if (flag === "--kubeconfig") {
      options.kubeconfig = resolve(nonemptyString(value, "--kubeconfig"));
    } else if (flag === "--image") {
      options.image = value;
    } else {
      throw new Error(`unknown qualification option ${flag}`);
    }
  }

  const cluster = safePathSegment(options.cluster, "--cluster");
  requireCondition(cluster.length <= 63, "--cluster must be at most 63 bytes");
  requireCondition(
    Number.isInteger(options.temporalPort) &&
      options.temporalPort >= 1_024 &&
      options.temporalPort <= 65_535,
    "--temporal-port must be an integer from 1024 to 65535",
  );
  const artifacts = nonemptyString(options.artifacts, "--artifacts");
  const kubeconfig = nonemptyString(options.kubeconfig, "--kubeconfig");
  const image = nonemptyString(options.image, "--image");
  requireCondition(
    PINNED_IMAGE.test(image),
    "--image must be a SHA-256 digest-pinned image",
  );
  requireCondition(
    artifacts !== kubeconfig,
    "--artifacts and --kubeconfig must be different paths",
  );
  const kubeconfigWithinArtifacts = relative(artifacts, kubeconfig);
  const artifactsWithinKubeconfig = relative(kubeconfig, artifacts);
  requireCondition(
    kubeconfigWithinArtifacts.startsWith("..") ||
      isAbsolute(kubeconfigWithinArtifacts),
    "--kubeconfig must not be inside --artifacts",
  );
  requireCondition(
    artifactsWithinKubeconfig.startsWith("..") ||
      isAbsolute(artifactsWithinKubeconfig),
    "--artifacts must not be inside --kubeconfig",
  );
  return {
    cluster,
    temporalPort: options.temporalPort,
    artifacts,
    kubeconfig,
    image,
  };
}

async function requireAbsent(path, label) {
  try {
    await lstat(path);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      return;
    }
    throw new Error(`could not inspect ${label}`, { cause });
  }
  throw new Error(`${label} already exists; qualification never replaces it`);
}

function parseClusterHandoff(output, expected) {
  const handoff = record(
    parseFinalJsonLine(output, "local cluster creation"),
    "local cluster handoff",
  );
  requireCondition(
    handoff.cluster === expected.cluster &&
      handoff.context === `kind-${expected.cluster}` &&
      handoff.artifacts === expected.artifacts &&
      handoff.loadedImage === expected.image &&
      handoff.temporalAddress === `127.0.0.1:${String(expected.temporalPort)}`,
    "local cluster handoff did not match the requested qualification",
  );
  return {
    cluster: expected.cluster,
    context: handoff.context,
    artifacts: expected.artifacts,
    temporalAddress: handoff.temporalAddress,
    kindBinary: nonemptyString(handoff.kindBinary, "handoff.kindBinary"),
    kubectlBinary: nonemptyString(
      handoff.kubectlBinary,
      "handoff.kubectlBinary",
    ),
  };
}

async function createCluster(options) {
  await Promise.all([
    requireAbsent(options.artifacts, "artifact root"),
    requireAbsent(options.kubeconfig, "kubeconfig"),
  ]);
  await Promise.all([
    mkdir(dirname(options.artifacts), { recursive: true }),
    mkdir(dirname(options.kubeconfig), { recursive: true }),
  ]);
  const isolatedConfiguration = await mkdtemp(
    join(tmpdir(), "moltzap-qualification-kubeconfig-"),
  );
  try {
    const output = await runCaptured(
      process.execPath,
      [
        localClusterCreator,
        "--cluster",
        options.cluster,
        "--temporal-port",
        String(options.temporalPort),
        "--artifacts",
        options.artifacts,
        "--image",
        options.image,
      ],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          KUBECONFIG: join(isolatedConfiguration, "config"),
        },
      },
      "local cluster creation",
    );
    const handoff = parseClusterHandoff(output, options);
    const kubeconfig = await runCaptured(
      handoff.kindBinary,
      ["get", "kubeconfig", "--name", options.cluster],
      { cwd: workspaceRoot, env: process.env },
      "kind kubeconfig export",
    );
    await writeFile(options.kubeconfig, kubeconfig, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return handoff;
  } finally {
    await rm(isolatedConfiguration, { recursive: true, force: true });
  }
}

function qualificationEnvironment(options, handoff) {
  const environment = {
    ...process.env,
    KUBECONFIG: options.kubeconfig,
    MOLTZAP_CONTROLLER_IMAGE: options.image,
    MOLTZAP_SUPPORT_IMAGE: options.image,
    MOLTZAP_KUBE_CONTEXT: handoff.context,
    MOLTZAP_TEMPORAL_ADDRESS: handoff.temporalAddress,
    MOLTZAP_LOCAL_ARTIFACT_ROOT: options.artifacts,
  };
  Reflect.deleteProperty(environment, "ANTHROPIC_API_KEY");
  Reflect.deleteProperty(environment, "OPENAI_API_KEY");
  return environment;
}

function sameCompletion(left, right) {
  return (
    left.ledgerFormatVersion === right.ledgerFormatVersion &&
    left.runId === right.runId &&
    left.recordCount === right.recordCount &&
    left.artifacts.manifest === right.artifacts.manifest &&
    left.artifacts.records === right.artifacts.records
  );
}

function recordsOf(records, eventClass) {
  return records.filter((entry) => entry.event instanceof eventClass);
}

export function validateEvidence(records) {
  const succeeded = recordsOf(records, ProgramSucceeded);
  const failed = recordsOf(records, ProgramFailed);
  const interrupted = recordsOf(records, ProgramInterrupted);
  const policySet = recordsOf(records, LinkPolicySet);
  const policyCleared = recordsOf(records, LinkPolicyCleared);

  requireCondition(
    succeeded.length === 1,
    `expected exactly one ProgramSucceeded, found ${String(succeeded.length)}`,
  );
  requireCondition(
    failed.length === 0,
    `expected no ProgramFailed, found ${String(failed.length)}`,
  );
  requireCondition(
    interrupted.length === 0,
    `expected no ProgramInterrupted, found ${String(interrupted.length)}`,
  );
  requireCondition(
    policySet.length === 1 && policySet[0].event.policy === "hold",
    "expected exactly one LinkPolicySet for hold",
  );
  requireCondition(
    policyCleared.length === 1 && policyCleared[0].event.policy === "hold",
    "expected exactly one LinkPolicyCleared for hold",
  );

  const set = policySet[0];
  const cleared = policyCleared[0];
  requireCondition(
    set.event.from === cleared.event.from && set.event.to === cleared.event.to,
    "hold policy evidence did not describe one directed link",
  );
  requireCondition(
    set.logicalSequence < cleared.logicalSequence &&
      cleared.logicalSequence < succeeded[0].logicalSequence,
    "hold policy evidence was not scoped before program success",
  );

  return {
    programSucceeded: succeeded.length,
    programFailed: failed.length,
    programInterrupted: interrupted.length,
    holdSet: policySet.length,
    holdCleared: policyCleared.length,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const handoff = await createCluster(options);
  const submission = parseSubmission(
    await runCaptured(
      process.execPath,
      [localProfile, scenario],
      {
        cwd: workspaceRoot,
        env: qualificationEnvironment(options, handoff),
      },
      "local profile",
      true,
    ),
  );
  const ref = Schema.decodeUnknownSync(ledgerRef)(submission.receipt.ledger);
  const ledgerDirectory = join(
    options.artifacts,
    submission.namespace,
    "ledger",
    safePathSegment(ref, "completed ledger reference"),
  );
  const [manifest, records, completion] = await Promise.all(
    ["manifest.json", "records.ndjson", "completion.json"].map((name) =>
      readFile(join(ledgerDirectory, name), "utf8"),
    ),
  );
  const opened = await Effect.runPromise(
    openLedgerArtifacts(
      coreEvents,
      ref,
      { manifest, records, completion },
      DEFINITION_ID,
    ),
  );
  requireCondition(
    sameCompletion(submission.receipt.completion, opened.completion),
    "RunSubmission receipt did not match the retained completion artifact",
  );
  const decodedRecords = Array.from(
    await Effect.runPromise(Stream.runCollect(opened.records)),
  );
  const evidence = validateEvidence(decodedRecords);

  process.stdout.write(
    `${JSON.stringify({
      qualification: "passed",
      cluster: handoff.cluster,
      context: handoff.context,
      kubeconfig: options.kubeconfig,
      artifacts: options.artifacts,
      temporalAddress: handoff.temporalAddress,
      kindBinary: handoff.kindBinary,
      kubectlBinary: handoff.kubectlBinary,
      runId: submission.runId,
      namespace: submission.namespace,
      ledger: ref,
      recordCount: opened.completion.recordCount,
      evidence,
    })}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
