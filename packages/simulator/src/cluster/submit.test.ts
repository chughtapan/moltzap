/** @file Submission input validation, workflow projection, and bounded diagnostic regressions. */

import { Cause, Data, Effect, Layer, Logger } from "effect";
import { describe, expect, it } from "vitest";
import type { RunControllerResult } from "./reclaim.js";
import type { RunTemporalSocietyOptions } from "./temporal.js";
import { LOCAL_KUBERNETES_EXECUTION_PROFILE } from "./profile.js";
import {
  boundedDiagnostic,
  type RunEnvironment,
  runKubernetesSociety,
  type RunSubmission,
  SUBMIT_STAGE,
  SubmitOperations,
  SUBMITTED_DIAGNOSTIC_MAX_BYTES,
} from "./submit.js";

const DIGEST = "b".repeat(64);
const APPLICATION_IMAGE = `registry/openclaw@sha256:${DIGEST}`;
const ENTRYPOINT = "society.mjs";
const STARTUP_TIMEOUT_VARIABLE = "MOLTZAP_STARTUP_TIMEOUT_MS";
const STARTUP_TIMEOUT_MS = 900_000;
const ADMISSION_TIMEOUT_VARIABLE = "MOLTZAP_ADMISSION_TIMEOUT_MS";
const ADMISSION_TIMEOUT_MS = 3_600_000;
const COHORT_SIZE_VARIABLE = "MOLTZAP_COHORT_SIZE";
const COHORT_SIZE = 100;
const RESULT: RunControllerResult = {
  exitCode: 1,
  summary: { _tag: "LedgerAllocationFailed" },
};

const ENVIRONMENT: RunEnvironment = {
  MOLTZAP_CONTROLLER_IMAGE: `registry/controller@sha256:${DIGEST}`,
  MOLTZAP_SUPPORT_IMAGE: `registry/support@sha256:${DIGEST}`,
  MOLTZAP_APPLICATION_IMAGE: APPLICATION_IMAGE,
};

interface Submitted {
  readonly options: RunTemporalSocietyOptions[];
}

describe("the experiment application image", () => {
  it("reaches the controller when the environment selects one", async () => {
    const { submitted } = await Effect.runPromise(submit(ENVIRONMENT));

    expect(submitted.options[0]?.input.applicationImage).toBe(
      APPLICATION_IMAGE,
    );
  });

  it("is optional for experiments that carry their images in source", async () => {
    const { submitted } = await Effect.runPromise(
      submit({ ...ENVIRONMENT, MOLTZAP_APPLICATION_IMAGE: undefined }),
    );

    expect(submitted.options[0]?.input.applicationImage).toBeUndefined();
  });

  it("refuses a mutable image reference", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        submit({
          ...ENVIRONMENT,
          MOLTZAP_APPLICATION_IMAGE: "registry/openclaw:latest",
        }),
      ),
    );

    expect(String(failure)).toContain("MOLTZAP_APPLICATION_IMAGE");
  });
});

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

/** What the filesystem said, which the reported detail deliberately drops. */
class UnreadableEntrypoint extends Data.TaggedError("UnreadableEntrypoint")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

// The reported detail is the same sentence for a missing file, a directory,
// and a permission denial, so the cause is the only place the operator can
// learn which one it was.
describe("an unreadable RunSpec entrypoint", () => {
  const unreadable = "the entrypoint is a directory";

  function capturingLogger(causes: string[]): Layer.Layer<never> {
    return Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ cause }) => {
        if (!Cause.isEmpty(cause)) {
          causes.push(Cause.pretty(cause));
        }
      }),
    );
  }

  it("logs the cause it refuses to report", async () => {
    const causes: string[] = [];

    const failure = await Effect.runPromise(
      Effect.flip(
        runKubernetesSociety(
          [ENTRYPOINT],
          ENVIRONMENT,
          LOCAL_KUBERNETES_EXECUTION_PROFILE,
        ).pipe(
          Effect.provide(
            Layer.succeed(SubmitOperations, {
              readTextFile: () =>
                Effect.fail(new UnreadableEntrypoint({ detail: unreadable })),
              randomUuid: () => "0123456789abcdef0123456789abcdef",
              runTemporalSociety: () => Promise.resolve(RESULT),
            }),
          ),
          Effect.provide(capturingLogger(causes)),
        ),
      ),
    );

    expect(failure.stage).toBe(SUBMIT_STAGE.module);
    expect(failure.message).not.toContain(unreadable);
    expect(causes.join("\n")).toContain(unreadable);
  });
});

describe("the run's cohort size", () => {
  it("reaches the workflow when the environment sets one", async () => {
    const { submitted } = await Effect.runPromise(
      submit({ ...ENVIRONMENT, [COHORT_SIZE_VARIABLE]: String(COHORT_SIZE) }),
    );

    expect(submitted.options[0]?.input.cohortSize).toBe(COHORT_SIZE);
  });

  it("is absent when the environment sets none, leaving the controller's default", async () => {
    const { submitted } = await Effect.runPromise(submit(ENVIRONMENT));

    expect(submitted.options[0]?.input.cohortSize).toBeUndefined();
  });

  it("refuses a size that is not a positive integer", async () => {
    for (const encoded of ["0", "-4", "2.5", "many"]) {
      const failure = await Effect.runPromise(
        Effect.flip(
          submit({ ...ENVIRONMENT, [COHORT_SIZE_VARIABLE]: encoded }),
        ),
      );

      expect(String(failure)).toContain(COHORT_SIZE_VARIABLE);
    }
  });
});

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

describe("the cohort's admission budget", () => {
  it("reaches the workflow apart from the startup budget when the environment sets one", async () => {
    const { submitted } = await Effect.runPromise(
      submit({
        ...ENVIRONMENT,
        [ADMISSION_TIMEOUT_VARIABLE]: String(ADMISSION_TIMEOUT_MS),
      }),
    );

    expect(submitted.options[0]?.input.admissionTimeoutMs).toBe(
      ADMISSION_TIMEOUT_MS,
    );
    expect(submitted.options[0]?.input.startupTimeoutMs).toBeUndefined();
  });

  it("is absent when the environment sets none, leaving the controller's default", async () => {
    const { submitted } = await Effect.runPromise(submit(ENVIRONMENT));

    expect(submitted.options[0]?.input.admissionTimeoutMs).toBeUndefined();
  });

  it("refuses a budget that is not a positive integer", async () => {
    for (const encoded of ["0", "-1", "1.5", "an hour"]) {
      const failure = await Effect.runPromise(
        Effect.flip(
          submit({ ...ENVIRONMENT, [ADMISSION_TIMEOUT_VARIABLE]: encoded }),
        ),
      );

      expect(String(failure)).toContain(ADMISSION_TIMEOUT_VARIABLE);
    }
  });
});

describe("the published controller diagnostic", () => {
  const byteLength = (value: string) =>
    new TextEncoder().encode(value).byteLength;

  it("keeps text already inside the bound exactly as it was", () => {
    for (const value of ["", "controller Job failed", "é".repeat(64)]) {
      expect(boundedDiagnostic(value)).toBe(value);
    }
  });

  // A multi-byte log is what makes a character bound and a byte bound differ,
  // and the trim has to land on a code point rather than inside one.
  it("holds every encoding to the byte bound without splitting a code point", () => {
    for (const unit of ["x", "é", "漢", "🙂"]) {
      const bounded = boundedDiagnostic(
        unit.repeat(SUBMITTED_DIAGNOSTIC_MAX_BYTES),
      );

      expect(byteLength(bounded)).toBeLessThanOrEqual(
        SUBMITTED_DIAGNOSTIC_MAX_BYTES,
      );
      expect(bounded).not.toContain("\uFFFD");
      expect(bounded.endsWith(unit)).toBe(true);
    }
  });

  // The reason a controller stopped is the last thing it writes.
  it("keeps the tail rather than the head", () => {
    const value = `${"x".repeat(SUBMITTED_DIAGNOSTIC_MAX_BYTES)}TAIL`;

    expect(boundedDiagnostic(value).endsWith("TAIL")).toBe(true);
  });
});
