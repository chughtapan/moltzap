/**
 * @file Property gates for the recording half: `Secrets.redact` (no
 * registered secret substring survives; fixpoint; encodings covered),
 * `recordingPath` injectivity, the local store's durably-at-most-once
 * seal, the reader's version gate, the seal-digest verification on
 * read, and the manifest's runtime provenance for a runtime backed by an
 * installed package.
 */
/* eslint-disable sonarjs/assertions-in-tests -- assertion bodies are extracted to named top-level functions to satisfy the nesting caps; every test delegates to one */
import { describe, expect, it } from "vitest";
import { Effect, FastCheck as fc, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { join } from "node:path";
import { AttemptId, LogicalSequence, WallTimeMs } from "./ids.js";
import {
  EpisodeOutcome,
  RECORDING_SCHEMA_VERSION,
  RecordingIdentity,
  ResultJson,
  makeSecrets,
  recordingPath,
  type RecordingRef,
  type RecordingStore,
} from "./recording.js";
import { Seed, SpecHash } from "./run-spec.js";
import { makeLocalRecordingStore, runIdFor } from "./local-store.js";
import {
  AGENT_ONE,
  agentInput,
  runHermetic,
  specInput,
  tempStoreRoot,
} from "./__tests__/support.js";
import {
  SHORT_INACTIVITY,
  doneEpisode,
  sealedPathOf,
} from "./__tests__/coverage-shared.js";
import { ERROR_TAG, EXIT, RUNTIME_KIND } from "./__tests__/tags.js";

const REDACTION_MARKER_PREFIX = "[REDACTED:k";

const secretText = fc
  .string({ minLength: 8, maxLength: 24, unit: "binary-ascii" })
  .filter(
    (value) =>
      value.trim().length >= 8 &&
      !value.includes("[") &&
      !value.includes("]") &&
      !/\s/u.test(value),
  );

function assertRedacted(secrets: ReadonlyArray<string>, filler: string): void {
  const registry = makeSecrets(secrets);
  const carriers = secrets.flatMap((secret) => [
    `${filler}${secret}${filler}`,
    `bearer ${Buffer.from(secret, "utf8").toString("base64")}`,
    `url=${encodeURIComponent(secret)}`,
  ]);
  for (const carrier of carriers) {
    const once = registry.redact(carrier);
    for (const secret of secrets) {
      expect(once.includes(secret)).toBe(false);
    }
    expect(registry.redact(once)).toBe(once);
  }
}

describe("Secrets.redact", () => {
  it("removes every registered secret and its base64/url encodings; redact is a fixpoint (property)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(secretText, { minLength: 1, maxLength: 4 }),
        fc.string({ maxLength: 40 }),
        assertRedacted,
      ),
    );
  });

  it("redactJson reaches every string in a structured payload", () => {
    const registry = makeSecrets(["hunter2secret"]);
    const redacted = registry.redactJson({
      nested: { key: "the value is hunter2secret indeed" },
      list: ["hunter2secret", 42, null],
    });
    expect(JSON.stringify(redacted).includes("hunter2secret")).toBe(false);
    expect(JSON.stringify(redacted)).toContain(REDACTION_MARKER_PREFIX);
  });
});

type IdentityFixture = {
  readonly specHash: string;
  readonly seed: number;
  readonly attempt: number;
};

function pathOf(entry: IdentityFixture): string {
  return recordingPath(
    "root",
    new RecordingIdentity({
      specHash: Schema.decodeSync(SpecHash)(entry.specHash),
      seed: Schema.decodeSync(Seed)(entry.seed),
    }),
    Schema.decodeSync(AttemptId)(`a${String(entry.attempt)}`),
  );
}

describe("recordingPath", () => {
  it("is injective over (identity, attemptId) (property)", () => {
    const hexChar = fc.constantFrom(..."0123456789abcdef");
    const specHash = fc
      .array(hexChar, { minLength: 64, maxLength: 64 })
      .map((chars) => chars.join(""));
    const identityArb = fc.record({
      specHash,
      seed: fc.integer({ min: 0, max: 999_999 }),
      attempt: fc.integer({ min: 1, max: 99 }),
    });
    fc.assert(
      fc.property(identityArb, identityArb, (left, right) => {
        const same =
          left.specHash === right.specHash &&
          left.seed === right.seed &&
          left.attempt === right.attempt;
        expect(pathOf(left) === pathOf(right)).toBe(same);
      }),
    );
  });
});

const SPEC_HASH = Schema.decodeSync(SpecHash)("b".repeat(64));
const SEED = Schema.decodeSync(Seed)(7);
const IDENTITY = new RecordingIdentity({ specHash: SPEC_HASH, seed: SEED });

function resultFixture(runId: ReturnType<typeof runIdFor>): ResultJson {
  return new ResultJson({
    recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
    runId,
    outcome: new EpisodeOutcome({ termination: "completed" }),
    endedAtWallTime: Schema.decodeSync(WallTimeMs)(Date.now()),
    finalLogicalSequence: Schema.decodeSync(LogicalSequence)(0),
    teardownComplete: true,
  });
}

function allocateRef(
  root: string,
  store: RecordingStore,
): Effect.Effect<RecordingRef, unknown> {
  return store.allocateAttempt(IDENTITY).pipe(
    Effect.map((allocated) => ({
      identity: IDENTITY,
      attemptId: allocated.attemptId,
      runId: allocated.runId,
      path: recordingPath(root, IDENTITY, allocated.attemptId),
    })),
  );
}

function writeFixtureManifest(
  path: string,
  content: string,
): Effect.Effect<void, unknown> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(join(path, "manifest.json"), content),
    ),
    Effect.provide(NodeContext.layer),
  );
}

function sealRaceBody(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const store = makeLocalRecordingStore(root);
    const ref = yield* allocateRef(root, store);
    yield* writeFixtureManifest(ref.path, "{}");
    const result = resultFixture(ref.runId);
    const attempts = yield* Effect.all(
      [
        Effect.exit(store.seal(ref, result)),
        Effect.exit(store.seal(ref, result)),
        Effect.exit(store.seal(ref, result)),
      ],
      { concurrency: 3 },
    );
    const wins = attempts.filter((exit) => exit._tag === EXIT.success);
    expect(wins.length).toBe(1);
    for (const exit of attempts) {
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit)).toContain(ERROR_TAG.alreadySealed);
      }
    }
    const append = yield* Effect.exit(store.appendEvents(ref, ["{}"]));
    expect(append._tag).toBe(EXIT.failure);
  });
}

function allocationRaceBody(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const store = makeLocalRecordingStore(root);
    const allocated = yield* Effect.all(
      Array.from({ length: 8 }, () => store.allocateAttempt(IDENTITY)),
      { concurrency: 8 },
    );
    const ids = allocated.map((entry) => entry.attemptId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of allocated) {
      expect(entry.runId).toBe(runIdFor(IDENTITY, entry.attemptId));
    }
  });
}

/** Appends one parseable events line so only the digest check can catch the tamper. */
function appendAfterSeal(path: string): Effect.Effect<void, unknown> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(join(path, "events.ndjson"), "{}\n", { flag: "a" }),
    ),
    Effect.provide(NodeContext.layer),
  );
}

function sealDigestTamperBody(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const outcome = yield* runHermetic(
      specInput(root, { episode: doneEpisode(SHORT_INACTIVITY) }),
      root,
    );
    const path = sealedPathOf(outcome.sealedExit);
    yield* appendAfterSeal(path);
    const read = yield* Effect.exit(outcome.store.read(path));
    expect(read._tag).toBe(EXIT.failure);
    expect(JSON.stringify(read)).toContain(ERROR_TAG.recordingUnsealed);
  });
}

function versionGateBody(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const store = makeLocalRecordingStore(root);
    const ref = yield* allocateRef(root, store);
    yield* writeFixtureManifest(
      ref.path,
      JSON.stringify({
        recordingSchemaVersion: RECORDING_SCHEMA_VERSION + 1,
      }),
    );
    const read = yield* Effect.exit(store.read(ref.path));
    expect(read._tag).toBe(EXIT.failure);
    expect(JSON.stringify(read)).toContain(ERROR_TAG.recordingSchemaMismatch);
  });
}

/** OpenClaw hides `./package.json` behind its export map, so provenance resolution has to reach the package root by path. */
const OPENCLAW_VERSION = new RegExp(
  `^${RUNTIME_KIND.openclaw}@\\d+\\.\\d+\\.\\d+`,
  "u",
);

function openclawProvenanceBody(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const outcome = yield* runHermetic(
      specInput(root, {
        agents: [
          agentInput(AGENT_ONE, { _tag: RUNTIME_KIND.openclaw, config: {} }),
        ],
        episode: doneEpisode(SHORT_INACTIVITY),
      }),
      root,
    );
    const snapshot = yield* outcome.store.read(
      sealedPathOf(outcome.sealedExit),
    );
    const slot = snapshot.manifest.slots.find(
      (entry) => entry.agent === AGENT_ONE,
    );
    expect(slot?.runtimeKind).toBe(RUNTIME_KIND.openclaw);
    expect(slot?.runtimeVersion).toMatch(OPENCLAW_VERSION);
  });
}

// @agent-code-guard/regression-only: the store invariants are exercised as concurrent races and byte-tamper regressions; the generative gates of this file live in the Secrets.redact and recordingPath describes
describe("LocalRecordingStore", () => {
  it("seals durably at most once: one winner, losers observe AlreadySealed, sealed files never rewrite (path 33 store half, property-adjacent race)", () =>
    Effect.runPromise(sealRaceBody().pipe(Effect.orDie)));

  it("allocates attempts atomically under concurrency: no duplicate attempt ids (property-adjacent race)", () =>
    Effect.runPromise(allocationRaceBody().pipe(Effect.orDie)));

  it("hard-fails on a recordingSchemaVersion mismatch before full decode (path 8 grader gate)", () =>
    Effect.runPromise(versionGateBody().pipe(Effect.orDie)));

  it("rejects a sealed recording whose bytes changed after sealing (seal digest verification, regression)", () =>
    Effect.runPromise(sealDigestTamperBody().pipe(Effect.orDie)));
});

// @agent-code-guard/regression-only: one installed runtime package is the whole population; the resolver's generative gates live in package-resolution.test.ts
describe("manifest provenance", () => {
  it("names the installed openclaw version for an openclaw slot (regression)", () =>
    Effect.runPromise(openclawProvenanceBody().pipe(Effect.orDie)));
});
