/** @file Startup failures expose safe diagnostics through every error representation. */

import { live as it } from "@effect/vitest";
import { ConfigError, ConfigProvider, Effect, Layer } from "effect";
import { expect } from "vitest";
import { configurationMessage } from "../../router.js";
import { RouterServer } from "../../server.js";

const registryOriginVariable = "MOLTZAP_ROUTER_REGISTRY_ORIGIN";
const rejectedValue =
  "https://operator:private-password@registry.example/private";
const environment = ConfigProvider.fromMap(
  new Map([[registryOriginVariable, rejectedValue]]),
);

it("removes configured values from startup error serialization and causes", () =>
  Effect.gen(function* () {
    const error = yield* Layer.build(RouterServer.layer).pipe(
      Effect.scoped,
      Effect.withConfigProvider(environment),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(RouterServer.StartupError);
    expect(error.message).toContain(registryOriginVariable);
    expect(JSON.stringify(error.toJSON())).not.toContain(rejectedValue);
    expect(String(error)).not.toContain(rejectedValue);
    expect(error.cause).toBeUndefined();
  }));

it("replaces unrecognized decoder messages with a fixed diagnostic", () =>
  Effect.sync(() => {
    expect(
      configurationMessage(ConfigError.InvalidData([], rejectedValue)),
    ).not.toContain(rejectedValue);
  }));

it("describes alternative configuration failures with or", () =>
  Effect.sync(() => {
    const leftPath = "LEFT";
    const rightPath = "RIGHT";
    const left = ConfigError.MissingData([leftPath], rejectedValue);
    const right = ConfigError.MissingData([rightPath], rejectedValue);
    const message = configurationMessage(ConfigError.Or(left, right));
    expect(message).toContain(configurationMessage(left));
    expect(message).toContain(configurationMessage(right));
    expect(message).not.toBe(
      configurationMessage(ConfigError.And(left, right)),
    );
  }));
