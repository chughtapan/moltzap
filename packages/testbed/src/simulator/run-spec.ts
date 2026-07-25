/**
 * @file RunSpec: the single registration point for every configurable
 * simulator field (contract 1, RunConfig / agent-runner — data half).
 *
 * One Effect Schema carries type, validation, description, and default
 * policy for the whole contract surface; no field metadata lives outside
 * it. Field classes: identity-bearing fields are required and never
 * defaulted; ergonomic fields carry schema defaults. The YAML frontend is
 * the encoded side of this schema and adds no capability; a field is
 * YAML-expressible iff `JSONSchema.make` succeeds on it.
 */
import { createHash } from "node:crypto";
import { Brand, Effect, ParseResult, Schema } from "effect";
import {
  FaultUnsupported,
  IsolationViolation,
  RunSpecInvalid,
  type ConfigTimeError,
} from "./errors.js";
import { checkAdapterConfig } from "./adapter-validation.js";
import {
  checkDoneSignalShape,
  checkDriverRef,
  type DoneSignalShape,
} from "./drivers.js";

// ---------------------------------------------------------------------------
// JSON value space
// ---------------------------------------------------------------------------

/**
 * The recursive JSON value space every data-valued field lives in.
 * Driver configs, provider parameters, event payload values, and captured
 * spans decode against it, so `undefined`, functions, bigints, cycles,
 * and non-finite numbers are rejected at the boundary and
 * `canonicalJson` is total over its input.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };
export const JsonValue: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(JsonValue),
    Schema.Record({ key: Schema.String, value: JsonValue }),
  ),
).annotations({
  // The identifier keeps the recursive schema JSONSchema-generable, which
  // is the YAML-expressibility oracle for every data-valued field.
  identifier: "JsonValue",
  description: "JSON value (finite numbers, no undefined)",
});

/** JSON object; the shape of every data-valued config bag. */
export const JsonObject = Schema.Record({
  key: Schema.String,
  value: JsonValue,
}).annotations({ description: "JSON object of JsonValue entries" });
export type JsonObject = typeof JsonObject.Type;

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

export type Seed = number & Brand.Brand<"Seed">;
/** Non-negative integer seed deriving the entire generative schedule. */
export const Seed: Schema.Schema<Seed, number> = Schema.Int.pipe(
  Schema.nonNegative(),
  Schema.brand("Seed"),
  Schema.annotations({
    description: "Deterministic seed for the generative schedule",
  }),
);

export type AgentName = string & Brand.Brand<"AgentName">;
/** Stable per-collection agent name; never allocated from construction order. */
export const AgentName: Schema.Schema<AgentName, string> =
  Schema.NonEmptyString.pipe(
    Schema.brand("AgentName"),
    Schema.annotations({
      description: "Agent name, unique within the run",
    }),
  );

export type PrincipalName = string & Brand.Brand<"PrincipalName">;
/** Principal identity that speech steps are attributed to (principal speech). */
export const PrincipalName: Schema.Schema<PrincipalName, string> =
  Schema.NonEmptyString.pipe(
    Schema.brand("PrincipalName"),
    Schema.annotations({
      description: "Principal identity name for speech attribution",
    }),
  );

export type StepName = string & Brand.Brand<"StepName">;
/** Handle of one speech step, so a later step can speak into the conversation it started. */
export const StepName: Schema.Schema<StepName, string> =
  Schema.NonEmptyString.pipe(
    Schema.brand("StepName"),
    Schema.annotations({
      description: "Speech-step handle, unique within the episode",
    }),
  );

export type SpecHash = string & Brand.Brand<"SpecHash">;
/** sha256 over the canonical serialization of the materialized spec, seed excluded. */
export const SpecHash: Schema.Schema<SpecHash, string> = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{64}$/),
  Schema.brand("SpecHash"),
  Schema.annotations({
    description: "Recording-identity spec hash (seed excluded)",
  }),
);

export type ImageDigest = string & Brand.Brand<"ImageDigest">;
/** Pinned container image digest (`sha256:...`). */
export const ImageDigest: Schema.Schema<ImageDigest, string> =
  Schema.String.pipe(
    Schema.pattern(/^sha256:[0-9a-f]{64}$/),
    Schema.brand("ImageDigest"),
    Schema.annotations({ description: "Container image digest pin" }),
  );

// ---------------------------------------------------------------------------
// Agent configuration (adapter-owned canonical configs)
// ---------------------------------------------------------------------------

/** Where the agent's runtime process runs; container is mandatory for adversarial roles. */
export const RunsIn = Schema.Literal("host", "container").annotations({
  description: "Where the agent's runtime process runs (host | container)",
});
export type RunsIn = typeof RunsIn.Type;

/** Behavioral role of the agent; adversarial requires container isolation. */
export const AgentRole = Schema.Literal("standard", "adversarial").annotations({
  description:
    "Agent role; adversarial triggers the config-time isolation check",
});
export type AgentRole = typeof AgentRole.Type;

/**
 * OpenClaw adapter canonical config. The adapter validates and fails fast
 * on anything it cannot honor; the simulator adds no normalized model
 * abstraction on top.
 */
export class OpenClawConfig extends Schema.Class<OpenClawConfig>(
  "OpenClawConfig",
)({
  modelId: Schema.optional(
    Schema.String.annotations({
      description: "Model identifier passed through to OpenClaw",
    }),
  ),
  openclawBin: Schema.optional(
    Schema.String.annotations({
      description:
        "Override path to the openclaw binary (tests, custom installs)",
    }),
  ),
}) {}

/** Nanoclaw adapter canonical config; modelId is honored (T11). */
export class NanoclawConfig extends Schema.Class<NanoclawConfig>(
  "NanoclawConfig",
)({
  modelId: Schema.optional(
    Schema.String.annotations({
      description: "Model identifier passed through to Nanoclaw",
    }),
  ),
  autoRegisterConversations: Schema.optionalWith(
    Schema.Boolean.annotations({
      description: "Register conversations on first delivery",
    }),
    { default: () => false },
  ),
}) {}

/** StubRuntime canonical config: a named behavior script, always bannered as scripted. */
export class StubConfig extends Schema.Class<StubConfig>("StubConfig")({
  script: Schema.String.annotations({
    description:
      "Registered StubRuntime behavior-script name (instrument fixture, not scenario logic)",
  }),
}) {}

export { RuntimeKind, FaultKind } from "./ids.js";

/**
 * Runtime assignment per agent: `agent -> (runtime kind + that
 * adapter's canonical config)`. The union is closed over registered
 * runtime kinds; heterogeneous kinds per collection are configuration.
 */
export const RuntimeAssignment = Schema.Union(
  Schema.TaggedStruct("openclaw", { config: OpenClawConfig }),
  Schema.TaggedStruct("nanoclaw", { config: NanoclawConfig }),
  Schema.TaggedStruct("stub", { config: StubConfig }),
).annotations({ description: "Runtime kind + adapter-owned canonical config" });
export type RuntimeAssignment = typeof RuntimeAssignment.Type;

/** One MCP server the simulator wires into the agent's runtime at spawn time. */
export class McpServer extends Schema.Class<McpServer>("McpServer")({
  name: Schema.NonEmptyString.annotations({
    description: "MCP server name, unique within the agent",
  }),
  command: Schema.NonEmptyString.annotations({
    description: "Command the simulator spawns for this MCP server",
  }),
  args: Schema.optionalWith(
    Schema.Array(Schema.String).annotations({
      description: "Command arguments",
    }),
    { default: () => [] },
  ),
  env: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }).annotations({
      description:
        "Environment for the spawned MCP server (subject to secret registration)",
    }),
    { default: () => ({}) },
  ),
}) {}

/** One agent: identity-bearing fields required, never defaulted. */
export class Agent extends Schema.Class<Agent>("Agent")({
  name: AgentName,
  runtime: RuntimeAssignment,
  runsIn: RunsIn,
  role: AgentRole,
  mcpServers: Schema.optionalWith(
    Schema.Array(McpServer).annotations({
      description:
        "MCP servers mounted at spawn, each wrapped in the logging proxy",
    }),
    { default: () => [] },
  ),
  workspaceFiles: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        relativePath: Schema.String.annotations({
          description: "Path relative to the agent workspace",
        }),
        content: Schema.String.annotations({
          description: "File content seeded into the workspace",
        }),
      }),
    ).annotations({ description: "Files seeded into the agent's workspace" }),
    { default: () => [] },
  ),
}) {}

// ---------------------------------------------------------------------------
// World / episode / recording / timeout groups
// ---------------------------------------------------------------------------

export type LogicalTime = number & Brand.Brand<"LogicalTime">;
/** Milliseconds on the run's logical clock; 0 at run begin. */
export const LogicalTime: Schema.Schema<LogicalTime, number> = Schema.Int.pipe(
  Schema.nonNegative(),
  Schema.brand("LogicalTime"),
  Schema.annotations({ description: "Logical-clock time in milliseconds" }),
);

/**
 * Connection-level fault vocabulary (never per-message lossy delivery).
 * v0's verified obligation is sever; delay and throttle stay expressible
 * and the v0 implementation rejects them with `FaultUnsupported`.
 */
export const FaultSpec = Schema.Union(
  Schema.TaggedStruct("sever", {
    target: AgentName.annotations({
      description: "Agent whose WS connection is severed",
    }),
  }),
  Schema.TaggedStruct("delay", {
    target: AgentName.annotations({
      description: "Agent whose connection is delayed",
    }),
    delayMs: Schema.Positive.annotations({
      description: "Added one-way latency in milliseconds",
    }),
  }),
  Schema.TaggedStruct("throttle", {
    target: AgentName.annotations({
      description: "Agent whose connection is throttled",
    }),
    bytesPerSecond: Schema.Positive.annotations({
      description: "Connection bandwidth cap",
    }),
  }),
).annotations({
  description: "Connection-level fault (apply/revert pair vocabulary)",
});
export type FaultSpec = typeof FaultSpec.Type;

/** A scheduled apply/revert pair at seed-derived logical times. */
export class FaultScheduleEntry extends Schema.Class<FaultScheduleEntry>(
  "FaultScheduleEntry",
)({
  fault: FaultSpec,
  applyAtMs: LogicalTime.annotations({
    description: "Logical time the fault applies",
  }),
  revertAtMs: LogicalTime.annotations({
    description: "Logical time the fault reverts (heal)",
  }),
}) {}

/** World configuration: synchrony/delivery treatments and the fault schedule. */
export class WorldSpec extends Schema.Class<WorldSpec>("WorldSpec")({
  faults: Schema.optionalWith(
    Schema.Array(FaultScheduleEntry).annotations({
      description: "Scheduled connection-level fault pairs",
    }),
    { default: () => [] },
  ),
}) {}

/** Serializable driver reference: a named implementation plus data-valued config, never a closure. */
export class DriverRef extends Schema.Class<DriverRef>("DriverRef")({
  name: Schema.NonEmptyString.annotations({
    description: "Registered driver implementation name",
  }),
  config: Schema.optionalWith(
    JsonObject.annotations({
      description: "Driver-owned config; JSON values only",
    }),
    { default: () => ({}) },
  ),
}) {}

/**
 * A participant of the task a `with:` step starts. Agent names and
 * principal names share one namespace and are collectively unique, so an
 * entry resolves to exactly one identity.
 */
const ParticipantName = Schema.Union(AgentName, PrincipalName).annotations({
  description: "Agent or principal taking part in the task a step starts",
});

/**
 * One speech act, delivered as the speech of the principal named in `by`.
 * Exactly one of the two primitives the protocol offers: `with` starts a
 * task with those participants alongside the speaker, creating or reusing
 * its conversation; `into` speaks into the conversation an earlier step
 * started. Nothing here declares a conversation — on this protocol a
 * conversation comes into being only through a task request, so speech is
 * the only way to create one.
 */
export class SpeechStep extends Schema.Class<SpeechStep>("SpeechStep")({
  name: Schema.optional(
    StepName.annotations({
      description: "Handle a later step's `into` can reference",
    }),
  ),
  by: PrincipalName.annotations({
    description:
      "Principal who speaks; never an agent, since agents speak for themselves",
  }),
  with: Schema.optional(
    Schema.NonEmptyArray(ParticipantName).annotations({
      description:
        "Start a task with these participants alongside the speaker; mutually exclusive with `into`",
    }),
  ),
  into: Schema.optional(
    StepName.annotations({
      description:
        "Speak into the conversation an earlier named step started; mutually exclusive with `with`",
    }),
  ),
  say: Schema.NonEmptyString.annotations({
    description: "Message body, delivered as the principal's speech",
  }),
  awaitReplyFrom: Schema.optional(
    AgentName.annotations({
      description:
        "Hold this step until the named agent has replied to the previous step",
    }),
  ),
  atMs: Schema.optionalWith(
    LogicalTime.annotations({
      description:
        "Logical position relative to episode start; a floor, never the sequencing device (array order sequences, `awaitReplyFrom` gates)",
    }),
    { default: () => 0 as LogicalTime },
  ),
}) {}

/** Crash policy when an agent process dies mid-episode. */
export const OnAgentCrash = Schema.Literal("halt", "continue").annotations({
  description:
    "halt: terminate the episode as agent-crashed; continue: event the crash and keep running",
});
export type OnAgentCrash = typeof OnAgentCrash.Type;

/** Episode termination policy: done-signal and inactivity bound both terminate the run in v0. */
export class TerminationPolicySpec extends Schema.Class<TerminationPolicySpec>(
  "TerminationPolicySpec",
)({
  inactivityTimeoutMs: Schema.Int.pipe(
    Schema.positive(),
    Schema.annotations({
      description:
        "Terminate with `timeout` after this many milliseconds with no society activity",
    }),
  ),
  onAgentCrash: OnAgentCrash,
  doneSignal: Schema.optional(
    DriverRef.annotations({
      description: "Predicate driver deciding episode completion",
    }),
  ),
}) {}

/** Episode configuration; v0 runs exactly one episode per run. */
export class EpisodeSpec extends Schema.Class<EpisodeSpec>("EpisodeSpec")({
  steps: Schema.NonEmptyArray(SpeechStep).annotations({
    description: "Ordered speech acts; array order is the only sequencing",
  }),
  termination: TerminationPolicySpec,
  principalDriver: Schema.optional(
    DriverRef.annotations({
      description:
        "Principal seam implementation; defaults to out-of-band delivery",
    }),
  ),
}) {}

/**
 * Condition designation: the single source of treatment labels. Nothing
 * in this object may reach any agent-visible channel; the hygiene test
 * enumerates the channels.
 */
export class ConditionDesignation extends Schema.Class<ConditionDesignation>(
  "ConditionDesignation",
)({
  label: Schema.NonEmptyString.annotations({
    description: "Treatment/condition label (never agent-visible)",
  }),
  notes: Schema.optional(
    Schema.String.annotations({
      description: "Free-form condition notes (never agent-visible)",
    }),
  ),
}) {}

/** Simulator-owned timeout knobs (ergonomic; defaulted). */
export class TimeoutsSpec extends Schema.Class<TimeoutsSpec>("TimeoutsSpec")({
  readyTimeoutMs: Schema.optionalWith(
    Schema.Int.pipe(
      Schema.positive(),
      Schema.annotations({
        description: "Per-agent readiness timeout in milliseconds",
      }),
    ),
    { default: () => 120_000 },
  ),
  otlpReceiverFailMs: Schema.optionalWith(
    Schema.Int.pipe(
      Schema.positive(),
      Schema.annotations({
        description:
          "Bounded receiver-loss fail time in milliseconds: the run fails with span-acceptance-lost when the OTLP receiver cannot acknowledge exports for this long",
      }),
    ),
    { default: () => 30_000 },
  ),
}) {}

/** Server-container configuration; the digest is identity-bearing. */
export class ServerSpec extends Schema.Class<ServerSpec>("ServerSpec")({
  imageDigest: ImageDigest.annotations({
    description:
      "Pinned digest of the server image built from the @moltzap/server-core bin",
  }),
}) {}

/** Recording emission configuration. */
export class RecordingSpec extends Schema.Class<RecordingSpec>("RecordingSpec")(
  {
    storeRoot: Schema.optionalWith(
      Schema.String.annotations({
        description: "RecordingStore root directory for the local store",
      }),
      { default: () => "./recordings" },
    ),
  },
) {}

// ---------------------------------------------------------------------------
// RunSpec: the one registry
// ---------------------------------------------------------------------------

/**
 * The complete, fully serializable run specification. The YAML frontend
 * encodes to this schema; the TS API constructs it directly; the manifest
 * persists its materialized form.
 */
export class RunSpec extends Schema.Class<RunSpec>("RunSpec")({
  seed: Seed,
  agents: Schema.NonEmptyArray(Agent).annotations({
    description: "The agent collection; agent names must be unique",
  }),
  server: ServerSpec,
  world: Schema.optionalWith(WorldSpec, {
    default: () => new WorldSpec({ faults: [] }),
  }),
  episode: EpisodeSpec,
  condition: Schema.optional(ConditionDesignation),
  contentVersion: Schema.optional(
    Schema.NonEmptyString.annotations({
      description:
        "Consumer content-version key; identity-bearing when present, never defaulted. Content axis of the spec, distinct from the recording format's recordingSchemaVersion; the spec hash covers it",
    }),
  ),
  timeouts: Schema.optionalWith(TimeoutsSpec, {
    default: () => TimeoutsSpec.make({}),
  }),
  recording: Schema.optionalWith(RecordingSpec, {
    default: () => RecordingSpec.make({}),
  }),
}) {}

/**
 * A RunSpec after materialization: every default resolved, every adapter
 * config validated by its adapter, the isolation check passed. The brand
 * is only constructible through `materializeRunSpec`.
 */
export type MaterializedRunSpec = RunSpec & Brand.Brand<"MaterializedRunSpec">;

/**
 * The materialized spec with the condition designation stripped. Every
 * component past materialization except manifest persistence receives
 * this projection, so treatment labels are unrepresentable downstream of
 * the recording boundary.
 */
export type AgentFacingRunSpec = Omit<MaterializedRunSpec, "condition">;

/** Per-field provenance recorded during materialization (drives `spec show`). */
export type FieldProvenance = {
  readonly path: ReadonlyArray<string>;
  readonly origin: "user" | "default" | "profile";
  readonly declaredDefault?: JsonValue;
};

export type MaterializationReport = {
  readonly spec: MaterializedRunSpec;
  readonly specHash: SpecHash;
  readonly provenance: ReadonlyArray<FieldProvenance>;
};

/**
 * Decode + validate + default-resolve an untrusted spec (YAML frontend or
 * TS caller) into its materialized form. Fails fast at config time:
 * schema violations, adapter-rejected fields, adversarial roles without
 * container isolation, fault kinds this build does not honor (v0: delay,
 * throttle), unregistered driver names, and driver-rejected configs never
 * reach launch. Cross-field rules validated here: agent names unique,
 * `revertAtMs > applyAtMs` per fault window, fault targets name existing
 * slots, the episode's step rules, and the done-signal shape rule.
 */
export function materializeRunSpec(
  input: unknown,
): Effect.Effect<MaterializationReport, ConfigTimeError, never> {
  return Effect.gen(function* () {
    const spec = yield* Schema.decodeUnknown(RunSpec)(input).pipe(
      Effect.mapError(specInvalidFromParseError),
    );
    const crossField = crossFieldIssues(spec);
    if (crossField.length > 0) {
      return yield* Effect.fail(
        new RunSpecInvalid({
          issues: crossField,
          message: `The spec decoded but violates ${String(crossField.length)} cross-field rule(s); fix the listed paths and re-run.`,
        }),
      );
    }
    yield* Effect.forEach(spec.agents, checkAdapterConfig, {
      concurrency: 1,
      discard: true,
    });
    yield* Effect.forEach(spec.agents, checkIsolation, {
      concurrency: 1,
      discard: true,
    });
    yield* Effect.forEach(spec.world.faults, checkFaultHonored, {
      concurrency: 1,
      discard: true,
    });
    if (spec.episode.termination.doneSignal !== undefined) {
      yield* checkDriverRef(spec.episode.termination.doneSignal, "done-signal");
      yield* checkDoneSignalShape(
        spec.episode.termination.doneSignal,
        unsafeCountingShape(spec.episode),
      );
    }
    if (spec.episode.principalDriver !== undefined) {
      yield* checkDriverRef(spec.episode.principalDriver, "principal");
    }
    const materialized = mintMaterializedRunSpec(spec);
    return {
      spec: materialized,
      specHash: computeSpecHash(materialized),
      provenance: collectProvenance(input, encodedSpecJson(spec)),
    };
  }).pipe(Effect.withSpan("materializeRunSpec"));
}

/**
 * A JSON value proven canonicalizable: finite numbers, acyclic, JSON-only
 * shapes. The brand is only mintable through `toCanonicalJson` or a
 * schema decode, so `canonicalJson`'s totality holds at the type level —
 * a raw TS literal with `NaN` or a cycle cannot reach it.
 */
export type CanonicalJson = JsonValue & Brand.Brand<"CanonicalJson">;

/** Validate an arbitrary value into the canonical space (rejects non-JSON shapes, non-finite numbers, cycles). */
export function toCanonicalJson(
  input: unknown,
): Effect.Effect<CanonicalJson, RunSpecInvalid, never> {
  const issues: Array<{ path: Array<string>; message: string }> = [];
  collectJsonIssues(input, [], new WeakSet(), issues);
  if (issues.length > 0) {
    return Effect.fail(
      new RunSpecInvalid({
        issues,
        message: `The value is outside the canonical JSON space at ${String(issues.length)} path(s); replace the listed values with finite, acyclic JSON.`,
      }),
    );
  }
  // The walk above rejects cycles, so the recursive schema decode terminates.
  return Schema.decodeUnknown(CanonicalJsonBrand)(input).pipe(
    Effect.mapError(specInvalidFromParseError),
  );
}

const CanonicalJsonBrand: Schema.Schema<CanonicalJson, JsonValue> =
  JsonValue.pipe(Schema.brand("CanonicalJson"));

/** Package-internal narrowing for structural walks over decoded JSON. */
export function isJsonRecord(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical serialization: UTF-8 JSON with lexicographically sorted keys
 * (code-unit order), no insignificant whitespace, shortest round-trip
 * numbers, `\n`-free single-line output (NDJSON-safe). Total over its
 * branded input. The byte-identity claims (derived schedule, spec-hash)
 * and every recording file's byte encoding are stated over this form.
 */
export function canonicalJson(value: CanonicalJson): string {
  return serializeCanonical(value);
}

/**
 * Package-internal sibling of `canonicalJson` for values already typed
 * inside the JSON space (schema encodes, redacted event payloads); the
 * public entry keeps the brand gate for arbitrary callers.
 */
export function serializeJsonCanonical(value: JsonValue): string {
  return serializeCanonical(value);
}

/** The sha256 over `canonicalJson` of the materialized spec with the seed field excluded. */
export function computeSpecHash(spec: MaterializedRunSpec): SpecHash {
  const withoutSeed = Object.fromEntries(
    Object.entries(encodedSpecJson(spec)).filter(([key]) => key !== "seed"),
  );
  const hex = createHash("sha256")
    .update(serializeCanonical(withoutSeed), "utf8")
    .digest("hex");
  return Schema.decodeSync(SpecHash)(hex);
}

// ---------------------------------------------------------------------------
// Canonical-space internals
// ---------------------------------------------------------------------------

const mintMaterializedRunSpec = Brand.nominal<MaterializedRunSpec>();

/**
 * The schema encode of a RunSpec lands in the JSON value space by
 * construction (every field schema encodes to JSON primitives); the
 * `JsonObject` decode re-proves that at the type level and dies loudly
 * if a future field schema ever leaves the space.
 */
function encodedSpecJson(spec: RunSpec): JsonObject {
  return Schema.decodeUnknownSync(JsonObject)(Schema.encodeSync(RunSpec)(spec));
}

type JsonIssue = { path: Array<string>; message: string };

function collectJsonIssues(
  value: unknown,
  path: Array<string>,
  seen: WeakSet<object>,
  issues: Array<JsonIssue>,
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issues.push({ path: [...path], message: "non-finite number" });
    }
    return;
  }
  if (typeof value !== "object") {
    issues.push({ path: [...path], message: `${typeof value} is not JSON` });
    return;
  }
  if (seen.has(value)) {
    issues.push({ path: [...path], message: "cyclic reference" });
    return;
  }
  seen.add(value);
  collectCompositeIssues(value, path, seen, issues);
  seen.delete(value);
}

function collectCompositeIssues(
  value: object,
  path: Array<string>,
  seen: WeakSet<object>,
  issues: Array<JsonIssue>,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectJsonIssues(entry, [...path, String(index)], seen, issues);
    });
    return;
  }
  if (!isPlainObject(value)) {
    issues.push({ path: [...path], message: "non-plain object is not JSON" });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    collectJsonIssues(entry, [...path, key], seen, issues);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeCanonical(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonical).join(",")}]`;
  }
  const entries = Object.entries(value)
    .sort(([left], [right]) => compareKeys(left, right))
    .map(
      ([key, entry]) => `${JSON.stringify(key)}:${serializeCanonical(entry)}`,
    );
  return `{${entries.join(",")}}`;
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Materialization internals
// ---------------------------------------------------------------------------

function specInvalidFromParseError(
  error: ParseResult.ParseError,
): RunSpecInvalid {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error).map(
    (issue) => ({
      path: issue.path.map(String),
      message: issue.message,
    }),
  );
  return new RunSpecInvalid({
    issues,
    message: `The spec failed schema decode at ${String(issues.length)} path(s); fix the listed fields against the RunSpec schema.`,
  });
}

type CrossFieldIssue = { path: Array<string>; message: string };

function crossFieldIssues(spec: RunSpec): Array<CrossFieldIssue> {
  const issues: Array<CrossFieldIssue> = [];
  const names = new Set<string>();
  spec.agents.forEach((agent, index) => {
    if (names.has(agent.name)) {
      issues.push({
        path: ["agents", String(index), "name"],
        message: `duplicate agent name "${agent.name}"; agent names must be unique within the run`,
      });
    }
    names.add(agent.name);
  });
  spec.world.faults.forEach((entry, index) => {
    if (entry.revertAtMs <= entry.applyAtMs) {
      issues.push({
        path: ["world", "faults", String(index), "revertAtMs"],
        message: `revertAtMs (${String(entry.revertAtMs)}) must be greater than applyAtMs (${String(entry.applyAtMs)})`,
      });
    }
    if (!names.has(entry.fault.target)) {
      issues.push({
        path: ["world", "faults", String(index), "fault", "target"],
        message: `fault target "${entry.fault.target}" names no agent in this spec`,
      });
    }
  });
  collectStepIssues(spec, names, issues);
  return issues;
}

/** One step under validation, with the names it may legally reference. */
type StepScope = {
  readonly step: SpeechStep;
  readonly index: number;
  readonly agentNames: ReadonlySet<string>;
  readonly principals: ReadonlySet<string>;
  /** Handles of the steps declared before this one. */
  readonly earlier: ReadonlySet<string>;
};

function stepPath(scope: StepScope, field: string): Array<string> {
  return ["episode", "steps", String(scope.index), field];
}

/**
 * The episode's cross-field rules. Agent names and principal names share
 * one namespace: a name used as both would mint two server identities and
 * break the grader's sender-to-name join.
 */
function collectStepIssues(
  spec: RunSpec,
  agentNames: ReadonlySet<string>,
  issues: Array<CrossFieldIssue>,
): void {
  const principals = new Set(spec.episode.steps.map((step) => step.by));
  const earlier = new Set<string>();
  spec.episode.steps.forEach((step, index) => {
    const scope: StepScope = {
      step,
      index,
      agentNames,
      principals,
      earlier: new Set(earlier),
    };
    collectStepShapeIssues(scope, issues);
    collectStepNameIssues(scope, issues);
    if (step.name !== undefined) earlier.add(step.name);
  });
  for (const principal of principals) {
    if (agentNames.has(principal)) {
      issues.push({
        path: ["episode", "steps"],
        message: `"${principal}" names both an agent and a principal; agent and principal names share one namespace and must be collectively unique`,
      });
    }
  }
}

function collectStepShapeIssues(
  scope: StepScope,
  issues: Array<CrossFieldIssue>,
): void {
  const { step } = scope;
  if ((step.with === undefined) === (step.into === undefined)) {
    issues.push({
      path: stepPath(scope, "with"),
      message:
        "a step either starts a task (`with`) or speaks into an earlier one (`into`); set exactly one",
    });
  }
  if (step.into !== undefined && !scope.earlier.has(step.into)) {
    issues.push({
      path: stepPath(scope, "into"),
      message: `"${step.into}" names no earlier step; \`into\` may only reference a step declared before this one`,
    });
  }
  if (step.name !== undefined && scope.earlier.has(step.name)) {
    issues.push({
      path: stepPath(scope, "name"),
      message: `duplicate step name "${step.name}"; step names must be unique within the episode`,
    });
  }
  if (step.awaitReplyFrom !== undefined && scope.index === 0) {
    issues.push({
      path: stepPath(scope, "awaitReplyFrom"),
      message:
        "the gate holds a step until the named agent replies to the previous step; the first step has none, so remove `awaitReplyFrom` or move this step later",
    });
  }
}

function collectStepNameIssues(
  scope: StepScope,
  issues: Array<CrossFieldIssue>,
): void {
  const { step } = scope;
  step.with?.forEach((participant, position) => {
    if (
      !scope.agentNames.has(participant) &&
      !scope.principals.has(participant)
    ) {
      issues.push({
        path: [...stepPath(scope, "with"), String(position)],
        message: `participant "${participant}" names no agent in this spec and no principal used in \`steps\``,
      });
    }
  });
  const replier = step.awaitReplyFrom;
  if (replier !== undefined && !scope.agentNames.has(replier)) {
    issues.push({
      path: stepPath(scope, "awaitReplyFrom"),
      message: `"${replier}" names no agent in this spec; only a launched agent produces the reply this step waits for`,
    });
  }
}

/**
 * The episode shape on which a done-signal counting society traffic can
 * fire before a later step is ever delivered — silently converting a
 * probe into a run that proves nothing while still producing a verdict.
 * A gate is the sharper report of the two, since a gated step is the one
 * a premature termination cancels.
 */
function unsafeCountingShape(
  episode: EpisodeSpec,
): DoneSignalShape | undefined {
  if (episode.steps.some((step) => step.awaitReplyFrom !== undefined)) {
    return "gated-step";
  }
  return episode.steps.length > 1 ? "multiple-steps" : undefined;
}

function checkIsolation(agent: Agent): Effect.Effect<void, IsolationViolation> {
  if (agent.role === "adversarial" && agent.runsIn !== "container") {
    return Effect.fail(
      new IsolationViolation({
        slot: agent.name,
        message: `Agent "${agent.name}" is adversarial but runs on the host; adversarial roles require runsIn: "container".`,
      }),
    );
  }
  return Effect.void;
}

function checkFaultHonored(
  entry: FaultScheduleEntry,
): Effect.Effect<void, FaultUnsupported> {
  if (entry.fault._tag !== "sever") {
    return Effect.fail(
      new FaultUnsupported({
        faultKind: entry.fault._tag,
        message: `Fault kind "${entry.fault._tag}" is expressible but not honored by this build (v0 honors sever/heal); remove the entry or run a build that honors it.`,
      }),
    );
  }
  return Effect.void;
}

/**
 * Per-field provenance from an input-presence diff: a leaf (or wholly
 * absent subtree) present in the materialized encoding but not in the
 * raw input originated from a schema default, and the materialized value
 * at that path is the declared default. Profiles stage later; no v0
 * field carries `origin: "profile"`.
 */
function collectProvenance(
  rawInput: unknown,
  encoded: JsonObject,
): Array<FieldProvenance> {
  const rows: Array<FieldProvenance> = [];
  for (const [key, entry] of Object.entries(encoded)) {
    walkProvenance(inputChild(rawInput, key), entry, [key], rows);
  }
  return rows;
}

function inputChild(input: unknown, key: string): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  if (!isPlainObject(input)) return undefined;
  return input[key];
}

function walkProvenance(
  input: unknown,
  encoded: JsonValue,
  path: Array<string>,
  rows: Array<FieldProvenance>,
): void {
  if (input === undefined) {
    rows.push({
      path: [...path],
      origin: "default",
      // The materialized value at a defaulted path is the resolved declared default.
      declaredDefault: encoded,
    });
    return;
  }
  if (Array.isArray(encoded)) {
    const inputArray: ReadonlyArray<unknown> = Array.isArray(input)
      ? input
      : [];
    encoded.forEach((entry, index) => {
      walkProvenance(inputArray[index], entry, [...path, String(index)], rows);
    });
    return;
  }
  if (encoded !== null && typeof encoded === "object") {
    for (const [key, entry] of Object.entries(encoded)) {
      walkProvenance(inputChild(input, key), entry, [...path, key], rows);
    }
    return;
  }
  rows.push({ path: [...path], origin: "user" });
}
