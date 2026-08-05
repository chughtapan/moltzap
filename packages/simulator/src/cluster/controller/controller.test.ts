/* eslint-disable agent-code-guard/no-example-only-tests -- Regression-only boundary tests pin one-shot dispatch, closed module exports, and failure redaction; the cases are lifecycle timelines rather than an input domain. */

import { assert, effect as test } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { RunSpec } from "../../definition.js";
import {
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
  ProgramFinished,
  ClusterLost,
} from "../../run/execute.js";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
} from "../../ledger/schema.js";
import { LedgerStorage, LedgerStorageError } from "../../ledger/storage.js";
import { RouterProvider } from "../../network/router.js";
import { ClusterError, Cluster } from "../cluster.js";
import { defineRuntime } from "../../agents/agent.js";
import {
  ControllerConfigurationError,
  controllerConfigurationFromEnvironment,
  type ControllerEnvironment,
} from "./configuration.js";
import {
  CONTROLLER_STAGE,
  ControllerError,
  ControllerOperations,
  runController,
  type ControllerOperationsService,
} from "./main.js";
import { isEntryModule } from "../entry.js";
import {
  exportCompletedLedger,
  LedgerExportOperations,
  type ControllerLedgerExportOptions,
  type LedgerExportOperationsService,
} from "./ledger-export.js";
import {
  CONTROLLER_SUMMARY_MAX_BYTES,
  CONTROLLER_SUMMARY_PREFIX,
  decodeControllerRunSummary,
  encodeControllerRunSummary,
  programFinishedSummary,
} from "./summary.js";

const IMAGE_DIGEST = "a".repeat(64);
const EXPECTED_NAMESPACE = "mz-run-1";
const EXPECTED_STARTUP_TIMEOUT_MS = 120_000;
const EXECUTION_RESULT = "executed";
const EXPECTED_MODULE_SPECIFIER = "file:///var/run/moltzap/experiment/main.mjs";
const LEDGER_REFERENCE = Schema.decodeSync(ledgerRef)(
  "controller-outcome-ledger",
);
const LEDGER_DIGEST = Schema.decodeSync(ledgerDigest)("b".repeat(64));
const COMPLETED_RECEIPT = CompletedLedgerReceipt.make({
  ledger: LEDGER_REFERENCE,
  completion: LedgerCompletion.make({
    ledgerFormatVersion: 1,
    runId: "controller-outcome-run",
    recordCount: 0,
    artifacts: { manifest: LEDGER_DIGEST, records: LEDGER_DIGEST },
  }),
});
const VALID_ENVIRONMENT: ControllerEnvironment = Object.freeze({
  MOLTZAP_RUN_NAMESPACE: EXPECTED_NAMESPACE,
  MOLTZAP_RUN_QUEUE: "society",
  MOLTZAP_RUN_OWNER_NAME: "run-root",
  MOLTZAP_RUN_OWNER_UID: "19193f95-73b8-49fb-bbd9-518773ba0331",
  MOLTZAP_SUPPORT_IMAGE: `registry.example/moltzap@sha256:${IMAGE_DIGEST}`,
  MOLTZAP_EXPERIMENT_MODULE: "/var/run/moltzap/experiment/main.mjs",
  MOLTZAP_LEDGER_DIRECTORY: "/var/lib/moltzap/ledger",
  MOLTZAP_ROUTER_URL: "https://router.mz-run-1.svc:3000",
});
const ACTIVE_LEDGER_DIRECTORY = "/var/lib/moltzap/ledger";
const EXPORT_DIRECTORY = `/var/lib/moltzap-artifacts/${EXPECTED_NAMESPACE}/ledger`;
const GKE_ENVIRONMENT: ControllerEnvironment = Object.freeze({
  ...VALID_ENVIRONMENT,
  MOLTZAP_LEDGER_EXPORT_DIRECTORY: EXPORT_DIRECTORY,
});
const VALID_PLACEMENT = {
  nodeSelector: { "moltzap.dev/pool": "agents" },
  tolerations: [
    {
      key: "moltzap.dev/agents",
      operator: "Equal",
      value: "true",
      effect: "NoSchedule",
    },
  ],
} as const;

const runtime = defineRuntime({
  name: "controller-entrypoint-test",
  configuration: { schema: Schema.Struct({}), value: {} },
});

const runSpec = RunSpec.define({
  id: "acme.controller-entrypoint/v1",
  events: [],
  agents: { alice: runtime },
  cluster: Layer.mergeAll(
    Layer.effect(LedgerStorage, Effect.never),
    Layer.effect(RouterProvider, Effect.never),
    Layer.effect(Cluster, Effect.never),
  ),
  execute: () => Effect.succeed("completed"),
});

function operations(
  imported: unknown,
  execution: ReturnType<ControllerOperationsService["executeRunSpec"]>,
): ControllerOperationsService {
  return {
    importModule: () => Promise.resolve(imported),
    executeRunSpec: () => execution,
    exportCompletedLedger: () => Effect.void,
  };
}

function controller(
  environment: ControllerEnvironment,
  operations: ControllerOperationsService,
) {
  return runController(environment).pipe(
    Effect.provideService(ControllerOperations, operations),
  );
}

function ledgerExport(
  options: ControllerLedgerExportOptions,
  operations: LedgerExportOperationsService,
) {
  return exportCompletedLedger(options).pipe(
    Effect.provideService(LedgerExportOperations, operations),
  );
}

test("decodes the closed controller environment without retaining mutable input", () =>
  Effect.sync(() => {
    const environment = { ...VALID_ENVIRONMENT };
    const configuration = controllerConfigurationFromEnvironment(environment);
    environment.MOLTZAP_RUN_NAMESPACE = "changed";

    assert.strictEqual(configuration.namespace, EXPECTED_NAMESPACE);
    assert.strictEqual(
      configuration.startupTimeoutMs,
      EXPECTED_STARTUP_TIMEOUT_MS,
    );
    assert.isUndefined(configuration.rosterPlacement);
    assert.isUndefined(configuration.ledgerExportDirectory);
    assert.deepStrictEqual(configuration.runtimeCredentials, {});
    assert.isTrue(Object.isFrozen(configuration));
    assert.isTrue(Object.isFrozen(configuration.owner));
  }));

test("decodes only supported transient provider credentials", () =>
  Effect.sync(() => {
    const configuration = controllerConfigurationFromEnvironment({
      ...VALID_ENVIRONMENT,
      MOLTZAP_RUNTIME_CREDENTIALS: JSON.stringify({
        OPENAI_API_KEY: "credential-value",
      }),
    });
    assert.deepStrictEqual(configuration.runtimeCredentials, {
      OPENAI_API_KEY: "credential-value",
    });
    assert.throws(
      () =>
        controllerConfigurationFromEnvironment({
          ...VALID_ENVIRONMENT,
          MOLTZAP_RUNTIME_CREDENTIALS: "{invalid",
        }),
      ControllerConfigurationError,
    );
  }));

test("decodes the optional retained ledger export root", () =>
  Effect.sync(() => {
    const configuration =
      controllerConfigurationFromEnvironment(GKE_ENVIRONMENT);
    assert.strictEqual(configuration.ledgerExportDirectory, EXPORT_DIRECTORY);
    assert.throws(
      () =>
        controllerConfigurationFromEnvironment({
          ...VALID_ENVIRONMENT,
          MOLTZAP_LEDGER_EXPORT_DIRECTORY: "relative/export",
        }),
      ControllerConfigurationError,
    );
  }));

test("decodes one closed roster placement and rejects partial configuration", () =>
  Effect.sync(() => {
    const configuration = controllerConfigurationFromEnvironment({
      ...VALID_ENVIRONMENT,
      MOLTZAP_ROSTER_PLACEMENT: JSON.stringify(VALID_PLACEMENT),
    });
    assert.deepStrictEqual(configuration.rosterPlacement, VALID_PLACEMENT);

    for (const placement of [
      { nodeSelector: VALID_PLACEMENT.nodeSelector },
      { nodeSelector: {}, tolerations: VALID_PLACEMENT.tolerations },
      {
        ...VALID_PLACEMENT,
        tolerations: [
          { ...VALID_PLACEMENT.tolerations[0], effect: "PreferNoSchedule" },
        ],
      },
    ]) {
      assert.throws(
        () =>
          controllerConfigurationFromEnvironment({
            ...VALID_ENVIRONMENT,
            MOLTZAP_ROSTER_PLACEMENT: JSON.stringify(placement),
          }),
        ControllerConfigurationError,
      );
    }
  }));

test("rejects configuration without repeating the supplied value", () =>
  Effect.sync(() => {
    const sensitiveInvalidValue = "not-a-digest-secret-value";
    let observed: unknown;
    try {
      controllerConfigurationFromEnvironment({
        ...VALID_ENVIRONMENT,
        MOLTZAP_SUPPORT_IMAGE: sensitiveInvalidValue,
      });
    } catch (cause: unknown) {
      observed = cause;
    }
    assert.instanceOf(observed, ControllerConfigurationError);
    assert.notInclude(observed.message, sensitiveInvalidValue);
  }));

test("recognizes a symlinked argv path as the loaded controller module", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "moltzap-controller-entrypoint-",
      });
      const canonicalModule = join(root, "controller-main.js");
      const linkedModule = join(root, "image-main.js");
      yield* fileSystem.writeFileString(canonicalModule, "");
      yield* fileSystem.symlink(canonicalModule, linkedModule);
      const moduleUrl = pathToFileURL(canonicalModule).href;

      assert.notStrictEqual(pathToFileURL(linkedModule).href, moduleUrl);
      assert.isTrue(isEntryModule(moduleUrl, linkedModule));
    }),
  ).pipe(Effect.provide(NodeContext.layer)));

test("imports and executes the single named runSpec exactly once", () =>
  Effect.gen(function* () {
    let importedSpecifier = "";
    let executions = 0;
    const execution = Effect.sync(() => {
      executions += 1;
      return new ProgramFinished({
        exit: Exit.succeed(EXECUTION_RESULT),
        receipt: COMPLETED_RECEIPT,
      });
    });
    const result = yield* controller(VALID_ENVIRONMENT, {
      importModule: (specifier) => {
        importedSpecifier = specifier;
        return Promise.resolve({ runSpec });
      },
      executeRunSpec: (loaded) =>
        Effect.sync(() => {
          assert.isTrue(Object.is(loaded, runSpec));
        }).pipe(Effect.zipRight(execution)),
      exportCompletedLedger: () => Effect.void,
    });

    assert.deepStrictEqual(result, programFinishedSummary(COMPLETED_RECEIPT));
    assert.strictEqual(executions, 1);
    assert.strictEqual(importedSpecifier, EXPECTED_MODULE_SPECIFIER);
  }));

test("exports completed ledger bytes with the completion marker last", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const written = new Map<string, Uint8Array>();
    const source = new Map(
      ["manifest.json", "records.ndjson", "completion.json"].map((artifact) => {
        const path = join(ACTIVE_LEDGER_DIRECTORY, LEDGER_REFERENCE, artifact);
        return [path, new TextEncoder().encode(artifact)] as const;
      }),
    );

    yield* ledgerExport(
      {
        ledgerDirectory: ACTIVE_LEDGER_DIRECTORY,
        exportDirectory: EXPORT_DIRECTORY,
        receipt: COMPLETED_RECEIPT,
      },
      {
        makeDirectory: (path) =>
          Effect.sync(() => {
            calls.push(`mkdir:${path}`);
          }),
        readFile: (path) =>
          Effect.sync(() => {
            calls.push(`read:${path}`);
            const content = source.get(path);
            assert.isDefined(content);
            return content;
          }),
        writeFile: (path, content) =>
          Effect.sync(() => {
            calls.push(`write:${path}`);
            written.set(path, content);
          }),
      },
    );

    const retained = join(EXPORT_DIRECTORY, LEDGER_REFERENCE);
    assert.deepStrictEqual(calls, [
      `mkdir:${retained}`,
      `read:${join(ACTIVE_LEDGER_DIRECTORY, LEDGER_REFERENCE, "manifest.json")}`,
      `write:${join(retained, "manifest.json")}`,
      `read:${join(ACTIVE_LEDGER_DIRECTORY, LEDGER_REFERENCE, "records.ndjson")}`,
      `write:${join(retained, "records.ndjson")}`,
      `read:${join(ACTIVE_LEDGER_DIRECTORY, LEDGER_REFERENCE, "completion.json")}`,
      `write:${join(retained, "completion.json")}`,
    ]);
    assert.deepStrictEqual(
      written.get(join(retained, "completion.json")),
      new TextEncoder().encode("completion.json"),
    );
  }));

test("retains a completed receipt before returning the controller summary", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let exported: ControllerLedgerExportOptions | undefined;
    const result = yield* controller(GKE_ENVIRONMENT, {
      importModule: () => Promise.resolve({ runSpec }),
      executeRunSpec: () =>
        Effect.sync(() => {
          calls.push("execute");
          return new ProgramFinished({
            exit: Exit.succeed(EXECUTION_RESULT),
            receipt: COMPLETED_RECEIPT,
          });
        }),
      exportCompletedLedger: (input) =>
        Effect.sync(() => {
          calls.push("export");
          exported = input;
        }),
    });

    assert.deepStrictEqual(calls, ["execute", "export"]);
    assert.deepStrictEqual(exported, {
      ledgerDirectory: VALID_ENVIRONMENT.MOLTZAP_LEDGER_DIRECTORY,
      exportDirectory: EXPORT_DIRECTORY,
      receipt: COMPLETED_RECEIPT,
    });
    assert.deepStrictEqual(result, programFinishedSummary(COMPLETED_RECEIPT));
  }));

test("reports a retained-artifact export failure before controller exit", () =>
  Effect.gen(function* () {
    const exportSecret = "gcs-export-secret-detail";
    const observed = yield* controller(GKE_ENVIRONMENT, {
      importModule: () => Promise.resolve({ runSpec }),
      executeRunSpec: () =>
        Effect.succeed(
          new ProgramFinished({
            exit: Exit.succeed(EXECUTION_RESULT),
            receipt: COMPLETED_RECEIPT,
          }),
        ),
      exportCompletedLedger: () => Effect.fail(exportSecret),
    }).pipe(Effect.flip);

    assert.instanceOf(observed, ControllerError);
    assert.strictEqual(observed.stage, CONTROLLER_STAGE.execution);
    assert.deepStrictEqual(observed.summary, {
      _tag: "ClusterLost",
      receipt: COMPLETED_RECEIPT,
    });
    assert.notInclude(observed.message, exportSecret);
  }));

test("rejects any additional module export before execution", () =>
  Effect.gen(function* () {
    let executions = 0;
    const execution = Effect.sync(() => {
      executions += 1;
    });
    const failure = yield* controller(
      VALID_ENVIRONMENT,
      operations({ runSpec, default: runSpec }, execution),
    ).pipe(Effect.flip);

    assert.instanceOf(failure, ControllerError);
    assert.strictEqual(failure.stage, CONTROLLER_STAGE.moduleLoad);
    assert.strictEqual(executions, 0);
  }));

test("sanitizes module and execution failures", () =>
  Effect.gen(function* () {
    const moduleSecret = "module-secret-detail";
    const moduleFailure = yield* controller(VALID_ENVIRONMENT, {
      importModule: () => Promise.reject(new Error(moduleSecret)),
      executeRunSpec: () => Effect.void,
      exportCompletedLedger: () => Effect.void,
    }).pipe(Effect.flip);
    assert.strictEqual(moduleFailure.stage, CONTROLLER_STAGE.moduleLoad);
    assert.notInclude(moduleFailure.message, moduleSecret);

    const executionSecret = "execution-secret-detail";
    const executionFailure = yield* controller(
      VALID_ENVIRONMENT,
      operations({ runSpec }, Effect.fail(executionSecret)),
    ).pipe(Effect.flip);
    assert.strictEqual(executionFailure.stage, CONTROLLER_STAGE.execution);
    assert.notInclude(executionFailure.message, executionSecret);
  }));

test("treats a ClusterLost outcome as controller failure", () =>
  Effect.gen(function* () {
    const clusterSecret = "ledger-mount-secret-detail";
    const outcome = new ClusterLost<Readonly<Record<string, never>>>({
      cause: Cause.fail(
        new ClusterError({
          detail: clusterSecret,
        }),
      ),
      receipt: IncompleteLedgerReceipt.make({ ledger: LEDGER_REFERENCE }),
    });
    const observed = yield* controller(
      VALID_ENVIRONMENT,
      operations({ runSpec }, Effect.succeed(outcome)),
    ).pipe(Effect.flip);

    assert.instanceOf(observed, ControllerError);
    assert.strictEqual(observed.stage, CONTROLLER_STAGE.execution);
    assert.deepStrictEqual(observed.summary, {
      _tag: "ClusterLost",
      receipt: outcome.receipt,
    });
    assert.notInclude(observed.message, clusterSecret);
  }));

test("keeps ProgramFinished successful when the customer Exit failed", () =>
  Effect.gen(function* () {
    const customerFailure = "customer-program-failure";
    const outcome = new ProgramFinished({
      exit: Exit.fail(customerFailure),
      receipt: COMPLETED_RECEIPT,
    });
    const observed = yield* controller(
      VALID_ENVIRONMENT,
      operations({ runSpec }, Effect.succeed(outcome)),
    );

    assert.deepStrictEqual(observed, programFinishedSummary(COMPLETED_RECEIPT));
    assert.isTrue(Exit.isFailure(outcome.exit));
    assert.notInclude(JSON.stringify(observed), customerFailure);
  }));

test("reports ledger allocation failure without inventing a receipt", () =>
  Effect.gen(function* () {
    const observed = yield* controller(
      VALID_ENVIRONMENT,
      operations(
        { runSpec },
        Effect.fail(
          LedgerStorageError.make({
            operation: "allocate",
            detail: "allocation-secret-detail",
          }),
        ),
      ),
    ).pipe(Effect.flip);

    assert.instanceOf(observed, ControllerError);
    assert.deepStrictEqual(observed.summary, {
      _tag: "LedgerAllocationFailed",
    });
    assert.notInclude(observed.message, "allocation-secret-detail");
  }));

test("round-trips only the final bounded closed result marker", () =>
  Effect.sync(() => {
    const summary = programFinishedSummary(COMPLETED_RECEIPT);
    const encoded = encodeControllerRunSummary(summary);
    assert.isDefined(encoded);

    assert.deepStrictEqual(
      decodeControllerRunSummary(`forged output\n${encoded}\n`),
      summary,
    );
    assert.isUndefined(
      decodeControllerRunSummary(
        `${CONTROLLER_SUMMARY_PREFIX}{"_tag":"LedgerAllocationFailed","extra":true}`,
      ),
    );
    assert.isUndefined(
      decodeControllerRunSummary(
        `${CONTROLLER_SUMMARY_PREFIX}${"x".repeat(CONTROLLER_SUMMARY_MAX_BYTES)}`,
      ),
    );
  }));

/* eslint-enable agent-code-guard/no-example-only-tests -- Restore generative-test defaults after the lifecycle regressions. */
