/**
 * @file Property gates for the RunSpec kernels: canonical serialization
 * (idempotence + roundtrip + single-line), spec-hash seed-independence,
 * materialization idempotence with the YAML-expressibility oracle, and
 * the config-time rejection paths. The research-transfer acceptance
 * tests live here too: `JSONSchema.make` succeeds over the whole spec
 * schema, and an encoded spec written and reloaded materializes
 * identically.
 */
/* eslint-disable sonarjs/assertions-in-tests -- assertion bodies are extracted to named top-level functions to satisfy the nesting caps; every test delegates to one */
import { describe, expect, it } from "vitest";
import { Effect, FastCheck as fc, JSONSchema, Schema } from "effect";
import {
  RunSpec,
  canonicalJson,
  materializeRunSpec,
  toCanonicalJson,
} from "./run-spec.js";
import {
  AGENT_ONE,
  AGENT_TWO,
  PRINCIPAL_NAME,
  specInput,
  stubAgentInput,
} from "./__tests__/support.js";
import { ERROR_TAG, EXIT, PROVENANCE } from "./__tests__/tags.js";
import { LAST_STEP_ANSWERED_DONE_SIGNAL } from "./drivers.js";

const STORE_ROOT = "./recordings-test";
const READY_TIMEOUT_DEFAULT = 120_000;

const jsonLeaf = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
);
const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    jsonLeaf,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie("value"), { maxKeys: 4 }),
  ),
})).value;

function canonical(value: unknown): string {
  return Effect.runSync(toCanonicalJson(value).pipe(Effect.map(canonicalJson)));
}

function materialize(input: unknown) {
  return Effect.runSync(materializeRunSpec(input));
}

function materializeExit(input: unknown) {
  return Effect.runSync(Effect.exit(materializeRunSpec(input)));
}

function expectFailedWithTag(
  exit: { readonly _tag: string },
  tag: string,
): void {
  expect(exit._tag).toBe(EXIT.failure);
  expect(JSON.stringify(exit)).toContain(tag);
}

const SOLO_STEP = { by: PRINCIPAL_NAME, with: [AGENT_ONE], say: "x" };

function episodeOf(steps: ReadonlyArray<unknown>, doneSignal?: unknown) {
  return {
    steps,
    termination: {
      inactivityTimeoutMs: 60_000,
      onAgentCrash: "halt",
      ...(doneSignal === undefined ? {} : { doneSignal }),
    },
  };
}

describe("canonicalJson", () => {
  it("is idempotent and parse inverts it (property)", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const once = canonical(value);
        const reparsed: unknown = JSON.parse(once);
        expect(canonical(reparsed)).toBe(once);
        expect(reparsed).toStrictEqual(JSON.parse(canonical(reparsed)));
      }),
    );
  });

  it("emits single-line output with a stable key order (property)", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const line = canonical(value);
        expect(line.includes("\n")).toBe(false);
        expect(canonical(JSON.parse(line))).toBe(line);
      }),
    );
  });

  it("rejects non-finite numbers and cycles", () => {
    const infinite = Effect.runSync(Effect.exit(toCanonicalJson(Infinity)));
    expect(infinite._tag).toBe(EXIT.failure);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const cycle = Effect.runSync(Effect.exit(toCanonicalJson(cyclic)));
    expect(cycle._tag).toBe(EXIT.failure);
  });
});

function assertSeedIndependence(seedA: number, seedB: number): void {
  const specA = materialize(specInput(STORE_ROOT, { seed: seedA }));
  const specB = materialize(specInput(STORE_ROOT, { seed: seedB }));
  expect(specA.specHash).toBe(specB.specHash);
}

describe("computeSpecHash", () => {
  it("is seed-independent and sensitive to any other field (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        assertSeedIndependence,
      ),
      { numRuns: 25 },
    );
    const base = materialize(specInput(STORE_ROOT));
    const differentSpeech = materialize(
      specInput(STORE_ROOT, {
        episode: episodeOf([
          { by: PRINCIPAL_NAME, with: [AGENT_ONE], say: "a different task" },
        ]),
      }),
    );
    expect(differentSpeech.specHash).not.toBe(base.specHash);
  });
});

function assertMaterializationIdempotent(seed: number): void {
  const first = materialize(specInput(STORE_ROOT, { seed }));
  const reEncoded = Schema.encodeSync(RunSpec)(first.spec);
  const second = materialize(reEncoded);
  expect(Schema.encodeSync(RunSpec)(second.spec)).toStrictEqual(reEncoded);
  expect(second.specHash).toBe(first.specHash);
}

function assertProvenanceRows(): void {
  const report = materialize(specInput(STORE_ROOT));
  const timeouts = report.provenance.find(
    (row) => row.path.join(".") === "timeouts.readyTimeoutMs",
  );
  expect(timeouts?.origin).toBe(PROVENANCE.default);
  expect(timeouts?.declaredDefault).toBe(READY_TIMEOUT_DEFAULT);
  const seed = report.provenance.find((row) => row.path.join(".") === "seed");
  expect(seed?.origin).toBe(PROVENANCE.user);
}

function assertCrossFieldRules(): void {
  const duplicate = materializeExit(
    specInput(STORE_ROOT, {
      agents: [stubAgentInput(AGENT_ONE), stubAgentInput(AGENT_ONE)],
    }),
  );
  expect(duplicate._tag).toBe(EXIT.failure);
  const badWindow = materializeExit(
    specInput(STORE_ROOT, {
      world: {
        faults: [
          {
            fault: { _tag: "sever", target: AGENT_ONE },
            applyAtMs: 100,
            revertAtMs: 100,
          },
        ],
      },
    }),
  );
  expect(badWindow._tag).toBe(EXIT.failure);
  const badTarget = materializeExit(
    specInput(STORE_ROOT, {
      world: {
        faults: [
          {
            fault: { _tag: "sever", target: "nobody" },
            applyAtMs: 100,
            revertAtMs: 200,
          },
        ],
      },
    }),
  );
  expect(badTarget._tag).toBe(EXIT.failure);
}

function assertAdapterFailFast(): void {
  const badScript = materializeExit(
    specInput(STORE_ROOT, {
      agents: [
        {
          name: AGENT_ONE,
          runtime: { _tag: "stub", config: { script: "no-such-script" } },
          runsIn: "host",
          role: "standard",
        },
      ],
      episode: episodeOf([SOLO_STEP]),
    }),
  );
  expectFailedWithTag(badScript, ERROR_TAG.adapterConfigRejected);
  const blankModel = materializeExit(
    specInput(STORE_ROOT, {
      agents: [
        {
          name: AGENT_ONE,
          runtime: { _tag: "nanoclaw", config: { modelId: "  " } },
          runsIn: "container",
          role: "standard",
        },
      ],
      episode: episodeOf([SOLO_STEP]),
    }),
  );
  expectFailedWithTag(blankModel, ERROR_TAG.adapterConfigRejected);
}

function assertGuardedFields(): void {
  const isolation = materializeExit(
    specInput(STORE_ROOT, {
      agents: [
        {
          name: AGENT_ONE,
          runtime: { _tag: "stub", config: { script: "quiet" } },
          runsIn: "host",
          role: "adversarial",
        },
      ],
      episode: episodeOf([SOLO_STEP]),
    }),
  );
  expectFailedWithTag(isolation, ERROR_TAG.isolationViolation);
  const unhonored = materializeExit(
    specInput(STORE_ROOT, {
      world: {
        faults: [
          {
            fault: { _tag: "delay", target: AGENT_ONE, delayMs: 50 },
            applyAtMs: 100,
            revertAtMs: 200,
          },
        ],
      },
    }),
  );
  expectFailedWithTag(unhonored, ERROR_TAG.faultUnsupported);
  const unknownDriver = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf(
        [{ by: PRINCIPAL_NAME, with: [AGENT_ONE], say: "x" }],
        { name: "no-such-driver" },
      ),
    }),
  );
  expectFailedWithTag(unknownDriver, ERROR_TAG.unknownDriver);
}

const SETUP_STEP = {
  name: "setup",
  by: PRINCIPAL_NAME,
  with: [AGENT_ONE],
  say: "the setup",
};

function assertStepRules(): void {
  const shape = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf([{ ...SETUP_STEP, into: "setup" }]),
    }),
  );
  expectFailedWithTag(shape, ERROR_TAG.runSpecInvalid);
  const forwardReference = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf([
        { by: PRINCIPAL_NAME, into: "later", say: "too early" },
        { name: "later", by: PRINCIPAL_NAME, with: [AGENT_ONE], say: "x" },
      ]),
    }),
  );
  expectFailedWithTag(forwardReference, ERROR_TAG.runSpecInvalid);
  const duplicateName = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf([SETUP_STEP, { ...SETUP_STEP, say: "again" }]),
    }),
  );
  expectFailedWithTag(duplicateName, ERROR_TAG.runSpecInvalid);
  const unknownParticipant = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf([{ by: PRINCIPAL_NAME, with: ["nobody"], say: "x" }]),
    }),
  );
  expectFailedWithTag(unknownParticipant, ERROR_TAG.runSpecInvalid);
  const sharedNamespace = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf([{ by: AGENT_ONE, with: [AGENT_TWO], say: "x" }]),
    }),
  );
  expectFailedWithTag(sharedNamespace, ERROR_TAG.runSpecInvalid);
}

function assertGateRules(): void {
  const unlaunchedReplier = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf([
        SETUP_STEP,
        {
          by: PRINCIPAL_NAME,
          into: "setup",
          awaitReplyFrom: "nobody",
          say: "probe",
        },
      ]),
    }),
  );
  expectFailedWithTag(unlaunchedReplier, ERROR_TAG.runSpecInvalid);
  const gatedFirstStep = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf([{ ...SETUP_STEP, awaitReplyFrom: AGENT_ONE }]),
    }),
  );
  expectFailedWithTag(gatedFirstStep, ERROR_TAG.runSpecInvalid);
}

const FOLLOW_UP_STEP = {
  by: PRINCIPAL_NAME,
  into: "setup",
  say: "follow-up",
};

/**
 * A done-signal that fires on society traffic can terminate a multi-step
 * run before a later step is spoken, and still produce a verdict over a
 * transcript that proves nothing. One clause covers it: a gated spec
 * always has more than one step, because a gate on the first step is
 * already refused.
 */
function assertDoneSignalShapeRule(): void {
  for (const doneSignal of [
    { name: "replies", config: { from: AGENT_ONE, minCount: 2 } },
  ]) {
    const rejected = materializeExit(
      specInput(STORE_ROOT, {
        episode: episodeOf([SETUP_STEP, FOLLOW_UP_STEP], doneSignal),
      }),
    );
    expectFailedWithTag(rejected, ERROR_TAG.doneSignalUnsafe);
    expect(JSON.stringify(rejected)).toContain(LAST_STEP_ANSWERED_DONE_SIGNAL);
  }
}

/**
 * Every legal spec has a legal way to reach `completed`: both
 * done-signals on a one-step spec, and `last-step-answered` on a
 * multi-step one. The fix line the guard prints names a driver that
 * actually resolves.
 */
function assertEveryShapeCanComplete(): void {
  const oneStep = [SETUP_STEP];
  const multiStep = [SETUP_STEP, FOLLOW_UP_STEP];
  const forOneStep = [
    { name: "replies", config: { from: AGENT_ONE } },
    { name: LAST_STEP_ANSWERED_DONE_SIGNAL, config: {} },
  ];
  for (const doneSignal of forOneStep) {
    const exit = materializeExit(
      specInput(STORE_ROOT, { episode: episodeOf(oneStep, doneSignal) }),
    );
    expect(exit._tag).toBe(EXIT.success);
  }
  const multiStepExit = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf(multiStep, {
        name: LAST_STEP_ANSWERED_DONE_SIGNAL,
        config: { from: AGENT_ONE },
      }),
    }),
  );
  expect(multiStepExit._tag).toBe(EXIT.success);
}

const SECOND_PRINCIPAL = "principal-second";

/**
 * Only a launched agent is ever the sender of a delivered message, so a
 * done-signal waiting on anyone else can never fire. Left to run, such a
 * spec burns its whole inactivity bound and seals `timeout` with nothing
 * in the recording to say the signal never could have fired.
 */
function assertDoneSignalTargetRule(): void {
  const unlaunched = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf([SETUP_STEP, FOLLOW_UP_STEP], {
        name: LAST_STEP_ANSWERED_DONE_SIGNAL,
        config: { from: "nobody" },
      }),
    }),
  );
  expectFailedWithTag(unlaunched, ERROR_TAG.driverConfigRejected);
  const principalTarget = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf([SETUP_STEP], {
        name: "replies",
        config: { from: PRINCIPAL_NAME },
      }),
    }),
  );
  expectFailedWithTag(principalTarget, ERROR_TAG.driverConfigRejected);
  // With `from` omitted the answerers are the last step's participants,
  // and here they are all principals.
  const principalsOnly = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf(
        [
          {
            name: "setup",
            by: PRINCIPAL_NAME,
            with: [SECOND_PRINCIPAL],
            say: "x",
          },
          { by: SECOND_PRINCIPAL, into: "setup", say: "y" },
        ],
        { name: LAST_STEP_ANSWERED_DONE_SIGNAL, config: {} },
      ),
    }),
  );
  expectFailedWithTag(principalsOnly, ERROR_TAG.driverConfigRejected);
}

describe("materializeRunSpec", () => {
  it("is idempotent over its own encoded output (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        assertMaterializationIdempotent,
      ),
      { numRuns: 20 },
    );
  });

  it("records provenance: defaulted paths carry origin default with the declared default", () => {
    assertProvenanceRows();
  });

  it("rejects duplicate agent names, bad fault windows, and unknown fault targets", () => {
    assertCrossFieldRules();
  });

  it("fails fast per adapter: unregistered stub script and blank modelId (path 23)", () => {
    assertAdapterFailFast();
  });

  it("enforces isolation, honored fault kinds, and registered drivers", () => {
    assertGuardedFields();
  });

  it("enforces the step rules: shape, ordering, unique names, resolvable participants, one namespace", () => {
    assertStepRules();
  });

  it("enforces the gate rules: the replier is a launched agent and a gated step has a previous one", () => {
    assertGateRules();
  });

  it("refuses a traffic-tracking done-signal on a multi-step episode", () => {
    assertDoneSignalShapeRule();
  });

  it("leaves every legal spec a legal way to reach completed", () => {
    assertEveryShapeCanComplete();
  });

  it("refuses a done-signal waiting on anyone this run does not launch", () => {
    assertDoneSignalTargetRule();
  });
});

function assertWriteAndReload(seed: number): void {
  const report = materialize(specInput(STORE_ROOT, { seed }));
  const written = canonical(Schema.encodeSync(RunSpec)(report.spec));
  const reloaded = materialize(JSON.parse(written));
  expect(reloaded.specHash).toBe(report.specHash);
  expect(canonical(Schema.encodeSync(RunSpec)(reloaded.spec))).toBe(written);
}

describe("research transfers (spec schema totality and persistence)", () => {
  it("JSONSchema.make succeeds over the whole RunSpec schema (to-ts/expressibility oracle)", () => {
    const jsonSchema = JSONSchema.make(RunSpec);
    expect(JSON.stringify(jsonSchema).length).toBeGreaterThan(0);
  });

  it("write-and-reload persists: canonical bytes round-trip to an identical materialization (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), assertWriteAndReload),
      { numRuns: 20 },
    );
  });
});
