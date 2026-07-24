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
import { Schema, type Brand, type Effect } from "effect";
import type { ConfigTimeError } from "./errors.js";

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
).annotations({ description: "JSON value (finite numbers, no undefined)" });

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

export type AgentSlotName = string & Brand.Brand<"AgentSlotName">;
/** Stable per-collection slot name; never allocated from construction order. */
export const AgentSlotName: Schema.Schema<AgentSlotName, string> =
  Schema.NonEmptyString.pipe(
    Schema.brand("AgentSlotName"),
    Schema.annotations({
      description: "Agent slot name, unique within the run",
    }),
  );

export type PrincipalName = string & Brand.Brand<"PrincipalName">;
/** Principal identity that seed tasks are attributed to (principal speech). */
export const PrincipalName: Schema.Schema<PrincipalName, string> =
  Schema.NonEmptyString.pipe(
    Schema.brand("PrincipalName"),
    Schema.annotations({
      description: "Principal identity name for task attribution",
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
// Slot configuration (adapter-owned canonical configs)
// ---------------------------------------------------------------------------

/** Isolation posture per slot; container is mandatory for adversarial roles. */
export const IsolationPosture = Schema.Literal("host", "container").annotations(
  {
    description: "Where the slot's runtime process runs (host | container)",
  },
);
export type IsolationPosture = typeof IsolationPosture.Type;

/** Behavioral role of the slot; adversarial requires container isolation. */
export const SlotRole = Schema.Literal("standard", "adversarial").annotations({
  description:
    "Slot role; adversarial triggers the config-time isolation check",
});
export type SlotRole = typeof SlotRole.Type;

/**
 * OpenClaw adapter canonical config. The adapter validates and fails fast
 * on anything it cannot honor; the simulator adds no normalized model
 * abstraction on top.
 */
export class OpenClawSlotConfig extends Schema.Class<OpenClawSlotConfig>(
  "OpenClawSlotConfig",
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
export class NanoclawSlotConfig extends Schema.Class<NanoclawSlotConfig>(
  "NanoclawSlotConfig",
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
export class StubSlotConfig extends Schema.Class<StubSlotConfig>(
  "StubSlotConfig",
)({
  script: Schema.String.annotations({
    description:
      "Registered StubRuntime behavior-script name (instrument fixture, not scenario logic)",
  }),
}) {}

/** Closed union of registered runtime kinds; provenance and events reuse it. */
export const SimulatorRuntimeKind = Schema.Literal(
  "openclaw",
  "nanoclaw",
  "stub",
).annotations({ description: "Registered runtime kind" });
export type SimulatorRuntimeKind = typeof SimulatorRuntimeKind.Type;

/**
 * Runtime assignment per slot: `agent_slot -> (runtime kind + that
 * adapter's canonical config)`. The union is closed over registered
 * runtime kinds; heterogeneous kinds per collection are configuration.
 */
export const RuntimeAssignment = Schema.Union(
  Schema.TaggedStruct("openclaw", { config: OpenClawSlotConfig }),
  Schema.TaggedStruct("nanoclaw", { config: NanoclawSlotConfig }),
  Schema.TaggedStruct("stub", { config: StubSlotConfig }),
).annotations({ description: "Runtime kind + adapter-owned canonical config" });
export type RuntimeAssignment = typeof RuntimeAssignment.Type;

/** One MCP server the simulator mounts into the slot's runtime at spawn time. */
export class McpServerMountSpec extends Schema.Class<McpServerMountSpec>(
  "McpServerMountSpec",
)({
  name: Schema.NonEmptyString.annotations({
    description: "Mount name, unique within the slot",
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

/** One agent slot: identity-bearing fields required, never defaulted. */
export class AgentSlotSpec extends Schema.Class<AgentSlotSpec>("AgentSlotSpec")(
  {
    slot: AgentSlotName,
    runtime: RuntimeAssignment,
    isolation: IsolationPosture,
    role: SlotRole,
    mounts: Schema.optionalWith(
      Schema.Array(McpServerMountSpec).annotations({
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
      ).annotations({ description: "Files seeded into the slot's workspace" }),
      { default: () => [] },
    ),
  },
) {}

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
/** Closed fault-kind vocabulary; events and errors reuse it instead of plain strings. */
export const FaultKind = Schema.Literal(
  "sever",
  "delay",
  "throttle",
).annotations({
  description: "Connection-level fault kind",
});
export type FaultKind = typeof FaultKind.Type;

export const FaultSpec = Schema.Union(
  Schema.TaggedStruct("sever", {
    target: AgentSlotName.annotations({
      description: "Slot whose WS connection is severed",
    }),
  }),
  Schema.TaggedStruct("delay", {
    target: AgentSlotName.annotations({
      description: "Slot whose connection is delayed",
    }),
    delayMs: Schema.Positive.annotations({
      description: "Added one-way latency in milliseconds",
    }),
  }),
  Schema.TaggedStruct("throttle", {
    target: AgentSlotName.annotations({
      description: "Slot whose connection is throttled",
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

/** WorldDriver configuration: synchrony/delivery treatments and the fault schedule. */
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

/** Seed task delivered as principal speech, attributed to a principal identity. */
export class TaskInjectionSpec extends Schema.Class<TaskInjectionSpec>(
  "TaskInjectionSpec",
)({
  principal: PrincipalName,
  to: AgentSlotName.annotations({
    description: "Slot the task is delivered to",
  }),
  content: Schema.String.annotations({
    description: "Task content delivered as the principal's speech",
  }),
  atMs: Schema.optionalWith(
    LogicalTime.annotations({
      description: "Logical arrival time; part of the seed-derived schedule",
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
  task: TaskInjectionSpec,
  termination: TerminationPolicySpec,
  principalDriver: Schema.optional(
    DriverRef.annotations({
      description:
        "PrincipalDriver seam implementation; defaults to out-of-band delivery",
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
  agents: Schema.NonEmptyArray(AgentSlotSpec).annotations({
    description: "The agent collection; slot names must be unique",
  }),
  server: ServerSpec,
  world: Schema.optionalWith(WorldSpec, {
    default: () => new WorldSpec({ faults: [] }),
  }),
  episode: EpisodeSpec,
  condition: Schema.optional(ConditionDesignation),
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

/** Per-field provenance recorded during materialization (drives `spec explain`). */
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
 * reach launch. Cross-field rules validated here: slot names unique,
 * `revertAtMs > applyAtMs` per fault window, fault targets name existing
 * slots.
 */
export function materializeRunSpec(
  _input: unknown,
): Effect.Effect<MaterializationReport, ConfigTimeError, never> {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}

/**
 * Canonical serialization: UTF-8 JSON with lexicographically sorted keys,
 * no insignificant whitespace, shortest round-trip numbers, `\n`-free
 * single-line output (NDJSON-safe). Total over `JsonValue`. The
 * byte-identity claims (derived schedule, spec-hash) and every recording
 * file's byte encoding are stated over this form.
 */
export function canonicalJson(_value: JsonValue): string {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}

/** The sha256 over `canonicalJson` of the materialized spec with the seed field excluded. */
export function computeSpecHash(_spec: MaterializedRunSpec): SpecHash {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}
