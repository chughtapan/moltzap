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

class ControllerExitedBeforeOutput extends Data.TaggedError(
  "ControllerExitedBeforeOutput",
)<{ readonly marker: string }> {}

function waitForOutput(child: ChildProcessWithoutNullStreams, marker: string) {
  return Effect.async<string, ControllerExitedBeforeOutput>((resume) => {
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
      resume(Effect.fail(new ControllerExitedBeforeOutput({ marker })));
    }
    child.stdout.on("data", receive);
    child.once("exit", exited);
    return Effect.sync(removeListeners);
  });
}

it("retains the final receipt after repeated SIGTERM during finalization", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    stdio: "pipe",
  });
  const exit = once(child, "exit");
  try {
    await Effect.runPromise(waitForOutput(child, "ready\n"));
    const finalizing = Effect.runPromise(waitForOutput(child, "finalizing\n"));
    child.kill("SIGTERM");
    await finalizing;
    const alive = Effect.runPromise(waitForOutput(child, "alive\n"));
    child.kill("SIGTERM");
    child.stdin.write("probe\n");
    await alive;
    const receipt = Effect.runPromise(waitForOutput(child, "\n"));
    child.kill("SIGTERM");
    child.stdin.write("release\n");
    const summary = decodeControllerRunSummary(await receipt);
    expect(summary?._tag).toBe("ClusterLost");
    const result: unknown = await exit;
    expect(
      Schema.decodeUnknownSync(Schema.Tuple(Schema.Number, Schema.Null))(
        result,
      ),
    ).toEqual([0, null]);
  } finally {
    child.kill("SIGKILL");
  }
}, 15_000);
