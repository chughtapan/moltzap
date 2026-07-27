/**
 * @file Adapter-owned canonical-config rules, applied at config time so
 * a field an adapter cannot honor fails fast and never reaches launch.
 * Each branch states the rules of one registered runtime kind; the
 * schema decode has already run, so only value-level rules live here.
 */
// safer-arch-ignore no-trivial-sink-file: per-kind value rules stay out of run-spec.ts so the registry keeps its function-size caps and new runtime kinds have one extension point.
import { Effect } from "effect";
import { AdapterConfigRejected } from "./errors.js";
import type { Agent } from "./run-spec.js";
import {
  registeredStubScriptNames,
  resolveStubScript,
} from "./stub-scripts.js";

function rejected(
  agent: Agent,
  field: string,
  detail: string,
): Effect.Effect<never, AdapterConfigRejected> {
  return Effect.fail(
    new AdapterConfigRejected({
      slot: agent.name,
      runtimeKind: agent.runtime._tag,
      field,
      message: `Agent "${agent.name}" (${agent.runtime._tag}) cannot honor "${field}": ${detail}`,
    }),
  );
}

function checkNonBlank(
  agent: Agent,
  field: string,
  value: string | undefined,
): Effect.Effect<void, AdapterConfigRejected> {
  if (value !== undefined && value.trim().length === 0) {
    return rejected(
      agent,
      field,
      "a blank value cannot be honored; set a real value or drop the field",
    );
  }
  return Effect.void;
}

/** Fail-fast adapter validation for one agent's runtime assignment. */
export function checkAdapterConfig(
  agent: Agent,
): Effect.Effect<void, AdapterConfigRejected> {
  const runtime = agent.runtime;
  switch (runtime._tag) {
    case "openclaw":
      return checkNonBlank(agent, "modelId", runtime.config.modelId).pipe(
        Effect.zipRight(
          checkNonBlank(agent, "openclawBin", runtime.config.openclawBin),
        ),
      );
    case "nanoclaw":
      return checkNonBlank(agent, "modelId", runtime.config.modelId);
    case "stub": {
      if (resolveStubScript(runtime.config.script) === undefined) {
        return rejected(
          agent,
          "script",
          `no registered StubRuntime script is named "${runtime.config.script}"; registered scripts: ${registeredStubScriptNames().join(", ")}`,
        );
      }
      return Effect.void;
    }
    default: {
      const exhaustive: never = runtime;
      return Effect.dieMessage(
        `unreachable runtime kind ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
