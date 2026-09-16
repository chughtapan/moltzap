/** @file Actual process signals cannot bypass controller evidence finalizers. */

import { Data, Effect, Schema } from "effect";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { decodeControllerRunSummary } from "./summary.js";

const CONTROLLER = new URL(
  "../../../dist/cluster/controller/main.js",
  import.meta.url,
);
const SUMMARY = new URL(
  "../../../dist/cluster/controller/summary.js",
  import.meta.url,
);
const LEDGER = new URL("../../../dist/ledger/schema.js", import.meta.url);
const RUN = new URL("../../../dist/run/execute.js", import.meta.url);

const CHILD = `
import { Effect } from "effect";
import { runControllerProcess } from ${JSON.stringify(CONTROLLER.href)};
import { clusterLostSummary, encodeControllerRunSummary } from ${JSON.stringify(SUMMARY.href)};
import { LedgerCompletion, ledgerRef, ledgerDigest } from ${JSON.stringify(LEDGER.href)};
import { CompletedLedgerReceipt } from ${JSON.stringify(RUN.href)};
const digest = ledgerDigest.make("a".repeat(64));
const receipt = CompletedLedgerReceipt.make({
  ledger: ledgerRef.make("signal-regression"),
  completion: LedgerCompletion.make({
    ledgerFormatVersion: 1, runId: "signal-regression", recordCount: 0,
    artifacts: { manifest: digest, records: digest },
  }),
});
const finalize = Effect.async((resume) => {
  process.stdout.write("finalizing\\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (command) => {
    if (command.trim() === "release") {
      resume(Effect.sync(() => {
        process.stdout.write(encodeControllerRunSummary(clusterLostSummary(receipt)) + "\\n");
      }));
    } else {
      process.stdout.write("alive\\n");
    }
  });
});
runControllerProcess(Effect.acquireUseRelease(
  Effect.sync(() => process.stdout.write("ready\\n")),
  () => Effect.never,
  () => finalize,
));
`;

/** Cold imports can exceed a minute under concurrent builds; signal handling has its own short deadline. */
const STARTUP_TIMEOUT_MS = 120_000;
const SIGNAL_TIMEOUT_MS = 5_000;

class ControllerOutputFailed extends Data.TaggedError(
  "ControllerOutputFailed",
)<{ readonly marker: string; readonly detail: string }> {}

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  marker: string,
  options: { readonly timeoutMs: number; readonly stderr: () => string },
) {
  return Effect.async<string, ControllerOutputFailed>((resume) => {
    let output = "";
    function removeListeners() {
      child.stdout.removeListener("data", receive);
      child.removeListener("exit", exited);
    }
    function receive(chunk: Buffer) {
      output += chunk.toString();
      if (output.includes(marker)) {
        removeListeners();
        resume(Effect.succeed(output));
      }
    }
    function exited() {
      removeListeners();
      resume(
        Effect.fail(
          new ControllerOutputFailed({
            marker,
            detail: `Controller exited before acknowledgement: ${options.stderr()}`,
          }),
        ),
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      exited();
      return;
    }
    child.stdout.on("data", receive);
    child.once("exit", exited);
    return Effect.sync(removeListeners);
  }).pipe(
    Effect.timeoutFail({
      duration: options.timeoutMs,
      onTimeout: () =>
        new ControllerOutputFailed({
          marker,
          detail: `No acknowledgement within ${String(options.timeoutMs)}ms: ${options.stderr()}`,
        }),
    }),
  );
}

it("retains the final receipt after repeated SIGTERM during finalization", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    stdio: "pipe",
  });
  const exit = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const wait = (marker: string, timeoutMs = SIGNAL_TIMEOUT_MS) =>
    Effect.runPromise(
      waitForOutput(child, marker, {
        timeoutMs,
        stderr: () => stderr,
      }),
    );
  try {
    await wait("ready\n", STARTUP_TIMEOUT_MS);
    const finalizing = wait("finalizing\n");
    child.kill("SIGTERM");
    await finalizing;
    const alive = wait("alive\n");
    child.kill("SIGTERM");
    child.stdin.write("probe\n");
    await alive;
    const receipt = wait("\n");
    child.kill("SIGTERM");
    child.stdin.write("release\n");
    const summary = decodeControllerRunSummary(await receipt);
    expect(summary?._tag).toBe("ClusterLost");
    const result: unknown = await Effect.runPromise(
      Effect.tryPromise(() => exit).pipe(Effect.timeout(SIGNAL_TIMEOUT_MS)),
    );
    expect(
      Schema.decodeUnknownSync(Schema.Tuple(Schema.Number, Schema.Null))(
        result,
      ),
    ).toEqual([0, null]);
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
}, 150_000);
