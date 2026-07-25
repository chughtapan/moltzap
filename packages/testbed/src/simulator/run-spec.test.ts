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
import {
  DONE_SIGNAL_SHAPE,
  ERROR_TAG,
  EXIT,
  PROVENANCE,
} from "./__tests__/tags.js";
import { SCHEDULE_AWARE_DONE_SIGNAL } from "./drivers.js";

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

function soloEpisode(): unknown {
  return {
    steps: [{ by: PRINCIPAL_NAME, with: [AGENT_ONE], say: "x" }],
    termination: { inactivityTimeoutMs: 60_000, onAgentCrash: "halt" },
  };
}

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
      episode: soloEpisode(),
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
      episode: soloEpisode(),
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
      episode: soloEpisode(),
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

/**
 * A counting done-signal fires on society traffic, so on these shapes it
 * can terminate the run before a later step is delivered — and still
 * produce a verdict over a transcript that proves nothing.
 */
function assertDoneSignalShapeRule(): void {
  const multiStep = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf(
        [SETUP_STEP, { by: PRINCIPAL_NAME, into: "setup", say: "follow-up" }],
        { name: "replies", config: { from: AGENT_ONE, minCount: 2 } },
      ),
    }),
  );
  expectFailedWithTag(multiStep, ERROR_TAG.doneSignalUnsafe);
  expect(JSON.stringify(multiStep)).toContain(SCHEDULE_AWARE_DONE_SIGNAL);
  const gated = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf(
        [
          SETUP_STEP,
          {
            by: PRINCIPAL_NAME,
            into: "setup",
            awaitReplyFrom: AGENT_ONE,
            say: "probe",
          },
        ],
        { name: "span-name", config: { name: "any.span" } },
      ),
    }),
  );
  expectFailedWithTag(gated, ERROR_TAG.doneSignalUnsafe);
  expect(JSON.stringify(gated)).toContain(DONE_SIGNAL_SHAPE.gatedStep);
  const singleStep = materializeExit(
    specInput(STORE_ROOT, {
      episode: episodeOf([SETUP_STEP], {
        name: "replies",
        config: { from: AGENT_ONE },
      }),
    }),
  );
  expect(singleStep._tag).toBe(EXIT.success);
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

  it("refuses a counting done-signal on a multi-step or gated episode", () => {
    assertDoneSignalShapeRule();
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
