/** @file Startup failures expose safe diagnostics through every error representation. */

import { NodeContext } from "@effect/platform-node";
import { live as it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { expect } from "vitest";
import { layer, StartupError } from "../server.js";

const rejectedValue =
  "postgresql://operator:private-password@localhost/database#invalid";
const databaseVariable = "MOLTZAP_REGISTRY_POSTGRESQL_URL";
const signingKeyVariable = "MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH";
const environment = ConfigProvider.fromMap(
  new Map([[databaseVariable, rejectedValue]]),
);

it("removes configured values from startup error serialization and causes", () =>
  Effect.gen(function* () {
    const error = yield* Layer.build(layer).pipe(
      Effect.scoped,
      Effect.withConfigProvider(environment),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(StartupError);
    expect(error.message).toContain(signingKeyVariable);
    expect(error.message).toContain(databaseVariable);
    expect(JSON.stringify(error.toJSON())).not.toContain(rejectedValue);
    expect(String(error)).not.toContain(rejectedValue);
    expect(error.cause).toBeUndefined();
  }));

it("identifies signing key file failures without exposing the path", () =>
  Effect.gen(function* () {
    const privatePath = "/missing/private-registry-signing-key.pem";
    const provider = ConfigProvider.fromMap(
      new Map([
        ["MOLTZAP_REGISTRY_PORT", "4100"],
        [databaseVariable, "postgresql://localhost/registry"],
        ["MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL", "admission-token"],
        [signingKeyVariable, privatePath],
      ]),
    );
    const error = yield* Layer.build(layer).pipe(
      Effect.scoped,
      Effect.withConfigProvider(provider),
      Effect.provide(NodeContext.layer),
      Effect.flip,
    );
    expect(error.message).toContain(signingKeyVariable);
    expect(JSON.stringify(error.toJSON())).not.toContain(privatePath);
    expect(String(error)).not.toContain(privatePath);
    expect(error.cause).toBeUndefined();
  }));
