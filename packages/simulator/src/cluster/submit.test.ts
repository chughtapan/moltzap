/* eslint-disable agent-code-guard/async-keyword -- The submitter boundary is Promise-native, so its assertions await it. */

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import type { RunControllerResult } from "./reclaim.js";
import { LOCAL_KUBERNETES_EXECUTION_PROFILE } from "./profile.js";
import {
  runKubernetesSociety,
  SubmitOperations,
  type RunEnvironment,
  type RunSubmission,
} from "./submit.js";
import type { RunTemporalSocietyOptions } from "./temporal.js";

const DIGEST = "b".repeat(64);
const ENTRYPOINT = "society.mjs";
const STARTUP_TIMEOUT_VARIABLE = "MOLTZAP_STARTUP_TIMEOUT_MS";
const STARTUP_TIMEOUT_MS = 900_000;
const RESULT: RunControllerResult = {
  exitCode: 1,
  summary: { _tag: "LedgerAllocationFailed" },
};

const ENVIRONMENT: RunEnvironment = {
  MOLTZAP_CONTROLLER_IMAGE: `registry/controller@sha256:${DIGEST}`,
  MOLTZAP_SUPPORT_IMAGE: `registry/support@sha256:${DIGEST}`,
};

interface Submitted {
  readonly options: RunTemporalSocietyOptions[];
}

function recordingOperations(
  submitted: Submitted,
): Layer.Layer<SubmitOperations> {
  return Layer.succeed(SubmitOperations, {
    readTextFile: () => Effect.succeed("export const runSpec = society;"),
    randomUuid: () => "0123456789abcdef0123456789abcdef",
    runTemporalSociety: (options: RunTemporalSocietyOptions) => {
      submitted.options.push(options);
      return Promise.resolve(RESULT);
    },
  });
}

function submit(
  environment: RunEnvironment,
): Effect.Effect<
  { readonly submission: RunSubmission; readonly submitted: Submitted },
  unknown
> {
  const submitted: Submitted = { options: [] };
  return runKubernetesSociety(
    [ENTRYPOINT],
    environment,
    LOCAL_KUBERNETES_EXECUTION_PROFILE,
  ).pipe(
    Effect.provide(recordingOperations(submitted)),
    Effect.map((submission) => ({ submission, submitted })),
  );
}

describe("the cohort's startup budget", () => {
  it("reaches the workflow when the environment sets one", async () => {
    const { submitted } = await Effect.runPromise(
      submit({
        ...ENVIRONMENT,
        [STARTUP_TIMEOUT_VARIABLE]: String(STARTUP_TIMEOUT_MS),
      }),
    );

    expect(submitted.options[0]?.input.startupTimeoutMs).toBe(
      STARTUP_TIMEOUT_MS,
    );
  });

  it("is absent when the environment sets none, leaving the controller's default", async () => {
    const { submitted } = await Effect.runPromise(submit(ENVIRONMENT));

    expect(submitted.options[0]?.input.startupTimeoutMs).toBeUndefined();
  });

  it("refuses a budget that is not a positive integer", async () => {
    for (const encoded of ["0", "-1", "1.5", "not-a-number"]) {
      const failure = await Effect.runPromise(
        Effect.flip(
          submit({ ...ENVIRONMENT, [STARTUP_TIMEOUT_VARIABLE]: encoded }),
        ),
      );

      expect(String(failure)).toContain(STARTUP_TIMEOUT_VARIABLE);
    }
  });
});

/* eslint-enable agent-code-guard/async-keyword -- Restore Effect-first test rules after the Promise-native submitter. */
