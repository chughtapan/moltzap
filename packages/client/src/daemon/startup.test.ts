/** @file Startup failures expose safe diagnostics through every error representation. */

import { live as it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { expect } from "vitest";
import { loadDaemonProcessConfiguration } from "./configuration.js";
import { Daemon } from "./index.js";

const registryOriginVariable = "SHARNESS_REGISTRY_ORIGIN";
const rejectedValue =
  "https://operator:private-password@registry.example/private";
const environment = ConfigProvider.fromMap(
  new Map([[registryOriginVariable, rejectedValue]]),
);

it("removes configured values from startup error serialization and causes", () =>
  Effect.gen(function* () {
    const error = yield* Layer.build(Daemon.layer).pipe(
      Effect.scoped,
      Effect.withConfigProvider(environment),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(Daemon.StartupError);
    expect(error.message).toContain(registryOriginVariable);
    expect(JSON.stringify(error.toJSON())).not.toContain(rejectedValue);
    expect(String(error)).not.toContain(rejectedValue);
    expect(error.cause).toBeUndefined();
  }));

it("removes decoder failures from daemon configuration errors", () =>
  Effect.gen(function* () {
    const error = yield* loadDaemonProcessConfiguration.pipe(
      Effect.withConfigProvider(environment),
      Effect.flip,
    );
    expect(error.message).toContain(registryOriginVariable);
    expect(JSON.stringify(error.toJSON())).not.toContain(rejectedValue);
    expect(String(error)).not.toContain(rejectedValue);
    expect(error.cause).toBeUndefined();
  }));

it("names both the closed compatibility reason and safe operator detail", () =>
  Effect.sync(() => {
    const error = new Daemon.StartupError({
      phase: "storage",
      reason: "outbox-too-old",
      detail: "Drain the outbox with an earlier release before upgrading",
    });
    expect(error.message).toContain(error.phase);
    expect(error.message).toContain(error.reason);
    expect(error.message).toContain(error.detail);
    expect(error.cause).toBeUndefined();
  }));
