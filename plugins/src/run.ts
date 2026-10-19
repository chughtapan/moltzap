/** @file Remote native receive composition: Client owns delivery; each provider leaf owns only wake acceptance. */

import { FileSystem } from "@effect/platform";
import { acquireHarnessEndpoint } from "@moltzap/client";
import { Config, Effect, Redacted, Schema, Stream } from "effect";
import { makeGrokWakeup } from "./grokbot/index.js";
import { makeInstinctWakeup } from "./instinct/index.js";
import { makeMuseWakeup } from "./muse/index.js";
import { NativeWakeError } from "./native/index.js";

const secretText = Schema.NonEmptyString.pipe(
  Schema.maxLength(4096),
  Schema.pattern(/^[A-Za-z0-9\-._~+/]+=*$/u),
);

/**
 * Runs inside the existing remote host, with one runtime grant shared with
 * the model connection. Muse polls outbound and confirms a local worker;
 * other leaves choose outbound polling or an exact HTTPS callback to Client.
 * Neither path exposes management MCP.
 *
 * A failed or uncertain handoff closes this process without acknowledging.
 * The host controls restart backoff; this program never retries a provider call.
 *
 * ```mermaid
 * flowchart TD
 *   Config[Host configuration and protected credential files] --> Client[Client authenticated MCP Events connection]
 *   Client --> Delivery[Canonical delivery and immutable reference]
 *   Delivery --> Wake[Selected native provider handoff]
 *   Wake --> Accepted{Provider acceptance?}
 *   Accepted -->|Yes| Receipt[Client delivery acknowledgement]
 *   Accepted -->|No or uncertain| Stop[Close scope and retain unread work]
 * ```
 *
 * @param onReady A host-local signal after Client acquires its poll lease or webhook subscription, never native work acceptance.
 * @returns A scoped receive loop; the remote host owns its process lifetime.
 */
export function runNativePlugin(onReady?: Effect.Effect<void>) {
  return Effect.gen(function* () {
    const platform = yield* readConfig(
      Config.literal("instinct", "grokbot", "muse")("MOLTZAP_NATIVE_PLATFORM"),
    );
    const endpoint = yield* readConfig(Config.url("MOLTZAP_MCP_URL"));
    const credential = yield* readSecret("MOLTZAP_MCP_CREDENTIAL_FILE");
    const delivery = yield* configuredDelivery(platform, onReady);
    const wake = yield* configuredWakeup(platform);
    const client = yield* acquireHarnessEndpoint(endpoint, {
      credential,
      delivery,
    });
    yield* Stream.runForEach(client.messages, (item) =>
      wake(item).pipe(Effect.andThen(item.acknowledge)),
    );
  }).pipe(Effect.scoped, Effect.withSpan("Native.runPlugin"));
}

function configuredDelivery(
  platform: "instinct" | "grokbot" | "muse",
  onReady?: Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const mode = yield* readConfig(
      Config.literal(
        "poll",
        "webhook",
      )("MOLTZAP_NATIVE_DELIVERY").pipe(
        Config.withDefault(platform === "muse" ? "poll" : "webhook"),
      ),
    );
    if (mode === "poll") {
      return { mode, ...(onReady === undefined ? {} : { onReady }) };
    }
    if (platform === "muse") {
      return yield* Effect.fail(
        new NativeWakeError({ reason: "invalid-configuration" }),
      );
    }
    return {
      mode,
      url: yield* readConfig(Config.string("MOLTZAP_NATIVE_WEBHOOK_URL")),
      port: yield* readConfig(Config.integer("MOLTZAP_NATIVE_WEBHOOK_PORT")),
      ...(onReady === undefined ? {} : { onReady }),
    };
  });
}

function configuredWakeup(platform: "instinct" | "grokbot" | "muse") {
  if (platform === "muse") {
    return readConfig(Config.string("MOLTZAP_MUSE_STATE_DIR")).pipe(
      Effect.flatMap(makeMuseWakeup),
    );
  }
  return platform === "instinct"
    ? Effect.gen(function* () {
        return makeInstinctWakeup({
          apiKey: yield* readSecret("MOLTZAP_AGENTMAIL_KEY_FILE"),
          inboxId: yield* readConfig(
            Config.string("MOLTZAP_AGENTMAIL_INBOX_ID"),
          ),
          recipient: yield* readConfig(Config.string("MOLTZAP_INSTINCT_EMAIL")),
        });
      })
    : Effect.gen(function* () {
        return makeGrokWakeup({
          url: yield* readConfig(Config.url("MOLTZAP_GROK_ROUTINE_URL")),
          key: yield* readSecret("MOLTZAP_GROK_ROUTINE_KEY_FILE"),
        });
      });
}

function readSecret(name: string) {
  return Effect.gen(function* () {
    const path = yield* readConfig(Config.redacted(name));
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs.readFile(Redacted.value(path)).pipe(
      Effect.catchTags({
        BadArgument: () =>
          Effect.fail(new NativeWakeError({ reason: "invalid-configuration" })),
        SystemError: () =>
          Effect.fail(new NativeWakeError({ reason: "invalid-configuration" })),
      }),
    );
    const text = yield* Effect.try({
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
      catch: () => new NativeWakeError({ reason: "invalid-configuration" }),
    });
    return yield* Schema.decodeUnknown(secretText)(text).pipe(
      Effect.map(Redacted.make),
      Effect.catchTag("ParseError", () =>
        Effect.fail(new NativeWakeError({ reason: "invalid-configuration" })),
      ),
    );
  }).pipe(Effect.withSpan("Native.readSecret"));
}

function readConfig<A>(config: Config.Config<A>) {
  return config.pipe(
    Effect.catchTag("ConfigError", () =>
      Effect.fail(new NativeWakeError({ reason: "invalid-configuration" })),
    ),
  );
}
