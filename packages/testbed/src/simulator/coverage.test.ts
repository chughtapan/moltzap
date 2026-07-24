/**
 * @file Coverage reconciliation for the hermetic CI tier: one entry per
 * coverage path from the pinned inventory (chughtapan/moltzap#810
 * appendix, paths 1-24) plus the extending failure-mode paths 27-35 the
 * design doc adds (extend, never shrink). Paths 25 (nightly real-runtime
 * acceptance) and 26 (demo TTHW benchmark) run outside vitest and are
 * documented in the design doc's verification section. Deleting an entry
 * shrinks the inventory, which the contract forbids. Path bodies live in
 * `__tests__/coverage-paths-{a,b}.ts`.
 *
 * Three entries stay `it.todo`: paths 20 and 30 await the parked
 * transcript-drain mechanism (escalation on chughtapan/moltzap#818), and
 * path 24 lands with the trace-capture fold row.
 */
/* eslint-disable sonarjs/assertions-in-tests -- every entry delegates to an imported path body whose assertions (expect/fc.assert) live in __tests__/coverage-paths-*.ts; this file is the flat inventory the contract pins */
// @agent-code-guard/regression-only: property evidence lives in the imported path bodies (fc.assert in coverage-paths-a/b); the inventory file itself stays a flat list
import { describe, it } from "vitest";
import { Effect } from "effect";
import {
  path1,
  path2,
  path3,
  path4,
  path5,
  path6,
  path7,
  path8,
  path9,
  path10,
  path11,
  path12,
} from "./__tests__/coverage-paths-a.js";
import {
  path13,
  path14,
  path15,
  path16,
  path17,
  path18,
  path19,
  path21,
  path22,
  path23,
  path27,
  path28,
  path29,
  path31,
  path32,
  path32Shutdown,
  path33,
  path34,
  path35,
} from "./__tests__/coverage-paths-b.js";

const run = (effect: Effect.Effect<void, unknown, never>) =>
  Effect.runPromise(effect.pipe(Effect.orDie));

describe("simulator coverage inventory (hermetic CI tier, paths 1-12)", () => {
  it("1. seed determinism: same seed, byte-identical canonical derived schedule (property)", () =>
    run(path1()));
  it("2. event log: unique strictly increasing logicalSequence under concurrent enqueue; rejection after seal (property)", () =>
    run(path2()));
  it("3. termination done-signal: sealed recording, termination completed", () =>
    run(path3()));
  it("4. termination inactivity timeout: sealed recording, termination timeout", () =>
    run(path4()));
  it("5. agent crash, policy halt: sealed recording, termination agent-crashed", () =>
    run(path5()));
  it("6. agent crash, policy continue: crash evented, run continues, sealed recording", () =>
    run(path6()));
  it("7. SIGINT mid-episode: sealed recording, termination interrupted, reverse teardown", () =>
    run(path7()));
  it("8. provenance: manifest carries the full identity set; grader hard-fails on recordingSchemaVersion mismatch", () =>
    run(path8()));
  it("9. parallel isolation: two concurrent runs, no port collision, distinct recordings, no span cross-contamination", () =>
    run(path9()));
  it("10. condition-label hygiene: labels absent from every enumerated agent-visible channel", () =>
    run(path10()));
  it("11. World fault: sever/heal via per-agent proxied ServerUrl; apply and revert recorded at logical times", () =>
    run(path11()));
  it("12. fault before agent-ready: no crash, no silent skip; recording shows scheduled apply and target-not-ready effect", () =>
    run(path12()));
});

describe("simulator coverage inventory (hermetic CI tier, paths 13-24)", () => {
  it("13. Environment OpenClaw: plugin/CLI-config wiring", () => run(path13()));
  it("14. Environment Nanoclaw: container-mount wiring", () => run(path14()));
  it("15. Environment absent: no-mount path unchanged", () => run(path15()));
  it("16. unknown span kind: recorded raw, never dropped (property)", () =>
    run(path16()));
  it("17. fault window overlapping episode end: revert after termination executed; both boundaries recorded", () =>
    run(path17()));
  it("18. server bring-up failure: sealed recording, reason server-launch-failed, reverse teardown", () =>
    run(path18()));
  it("19. OTLP receiver unavailable or stalled: run fails within timeouts.otlpReceiverFailMs; reason span-acceptance-lost", () =>
    run(path19()));
  it.todo(
    "20. transcript drain: drained content matches sent messages under the redaction policy; observer traffic excluded",
  );
  it("21. MCP logging proxy: tool calls captured; tool results byte-identical with and without the proxy", () =>
    run(path21()));
  it("22. principal-speech injection: seed task attributed to a principal identity, never a system sender", () =>
    run(path22()));
  it("23. per-adapter canonical config: unsupported field fails fast at config time (property)", () =>
    run(path23()));
  it.todo(
    "24. cc-judge compat (CRITICAL): dist loader runs the compat adapter over EVAL-005.yaml against the verify-row oracle",
  );
});

describe("simulator coverage inventory (design-doc extension paths)", () => {
  it("27. partial multi-agent launch: reverse teardown of started agents; sealed recording, reason agent-launch-failed", () =>
    run(path27()));
  it("28. principal/world-driver crash after readiness: sealed recording, reason driver-crashed (seal-site mapping property)", () =>
    run(path28()));
  it("29. OTLP backpressure: acknowledgment stall beyond bound fails the run; no silent span loss", () =>
    run(path29()));
  it.todo(
    "30. transcript-drain failure: sealed recording, reason transcript-drain-failed",
  );
  it("31. logging-proxy failure mid-run: sealed recording, reason logging-proxy-failed", () =>
    run(path31()));
  it("32. fault-revert failure: sealed recording, reason fault-revert-failed", () =>
    run(path32()));
  it("32b. fault-revert failure in the post-termination sweep: sealed recording, reason fault-revert-failed (regression)", () =>
    run(path32Shutdown()));
  it("33. cancellation racing completion: exactly one sealed outcome; late cancel is a recorded no-op", () =>
    run(path33()));
  it("34. queue-worker death mid-attempt: attempt observable as unsealed with workerLost; retry creates a new attempt", () =>
    run(path34()));
  it("35. teardown that cannot fully reverse: sealed recording, teardownComplete false, failures evented", () =>
    run(path35()));
});
