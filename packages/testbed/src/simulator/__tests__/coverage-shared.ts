/**
 * @file Shared fixtures of the coverage-path bodies: episode inputs,
 * fault-window builders, and the sealed-outcome accessor.
 */
import { expect } from "vitest";
import type { Exit } from "effect";
import {
  AGENT_ONE,
  DONE_SPAN,
  PRINCIPAL_NAME,
  TASK_CONTENT,
} from "./support.js";
import { EXIT } from "./tags.js";

export const SHORT_INACTIVITY = 300;
export const CONDITION_LABEL = "TREATMENT-X9";

export function doneEpisode(
  inactivityMs: number,
  onAgentCrash = "halt",
): unknown {
  return {
    task: { principal: PRINCIPAL_NAME, to: AGENT_ONE, content: TASK_CONTENT },
    termination: {
      inactivityTimeoutMs: inactivityMs,
      onAgentCrash,
      doneSignal: { name: "span-name", config: { name: DONE_SPAN } },
    },
  };
}

export function severWindow(
  target: string,
  applyAtMs: number,
  revertAtMs: number,
): unknown {
  return { fault: { _tag: "sever", target }, applyAtMs, revertAtMs };
}

export function outcomeOf(
  sealed: Exit.Exit<{ outcome: unknown }, unknown>,
): unknown {
  expect(sealed._tag).toBe(EXIT.success);
  return sealed._tag === "Success" ? sealed.value.outcome : undefined;
}
