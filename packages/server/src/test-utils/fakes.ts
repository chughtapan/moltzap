/**
 * Layer-based test doubles for server services.
 *
 * Motivation: hand-rolled mock objects (e.g. `vi.spyOn(client, "callSync")`
 * plus ad-hoc `mockResolvedValue`) drift from the real service interface —
 * tests keep passing while production code ships with a different shape.
 * The `sendToAgent` contract drift bug (A7) is the canonical example.
 *
 * These helpers produce test doubles that are *structurally typed against
 * the real service interface*. If the real interface changes, the test
 * double becomes a compile error instead of a silent runtime mismatch.
 *
 * Two modes:
 *   (1) Typed plain-object fakes — for services that are passed around as
 *       instances (e.g. `new WebhookUserService(client, ...)`). Use
 *       `makeFakeService<T>()` or the service-specific helpers below.
 *   (2) Layer-based fakes — for services accessed via `Context.Tag`. These
 *       slot into an Effect program via `Layer.provide(program, fakeLayer)`.
 */

import { Layer } from "effect";

import type { WebhookClient } from "../adapters/webhook.js";
import type { AppHost, DefaultPermissionService } from "../app/app-host.js";
import type { AuthService } from "../services/auth.service.js";
import type { ConversationService } from "../services/conversation.service.js";
import type { DeliveryService } from "../services/delivery.service.js";
import type { MessageService } from "../services/message.service.js";
import type { ParticipantService } from "../services/participant.service.js";
import type { PresenceService } from "../services/presence.service.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager } from "../ws/connection.js";

import {
  AppHostTag,
  AuthServiceTag,
  BroadcasterTag,
  ConnectionManagerTag,
  ConversationServiceTag,
  DefaultPermissionServiceTag,
  DeliveryServiceTag,
  MessageServiceTag,
  ParticipantServiceTag,
  PresenceServiceTag,
} from "../app/layers.js";

// ── Generic typed fake factory ─────────────────────────────────────────────

/**
 * Build a typed test double for an interface `S` from a partial implementation.
 * The cast is intentional: tests typically implement only the methods the
 * system under test actually calls. Unused methods throw at runtime via the
 * `Proxy` trap so a missing implementation becomes a clear test failure
 * instead of `undefined is not a function`.
 *
 * Because the generic parameter `S` is invariant, TypeScript still enforces
 * that every method you *do* implement matches the real signature — this is
 * the compile-time contract-drift insurance. Adding a field to the real
 * interface does NOT fail compilation (tests are a Partial), but changing an
 * existing field's signature does.
 */
export const makeFakeService = <S extends object>(impl: Partial<S>): S =>
  new Proxy(impl, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      // Symbol lookups (e.g. Symbol.toPrimitive) — let the default behavior run.
      if (typeof prop === "symbol") return undefined;
      throw new Error(
        `FakeService: method '${String(prop)}' was called but not implemented. ` +
          `Add it to the test double.`,
      );
    },
  }) as S;

// ── Webhook client — not behind a Tag, used via constructor injection ──────

/**
 * Typed test double for `WebhookClient`. Use instead of `vi.spyOn` on a real
 * instance: the `Pick<>` constraint forces the caller to match the real
 * `callSync` signature, so a contract change in `WebhookClient` breaks the
 * test at compile time rather than at runtime.
 *
 * Example:
 *   const client = makeFakeWebhookClient({
 *     callSync: async () => ({ valid: true }),
 *   });
 *   const svc = new WebhookUserService(client, "url", 5000, logger);
 */
export const makeFakeWebhookClient = (
  impl: Pick<WebhookClient, "callSync">,
): WebhookClient => impl as WebhookClient;

// ── Layer-based fakes for tagged services ──────────────────────────────────
//
// Each helper wraps a `Partial<S>` in `makeFakeService` then lifts it into a
// `Layer` keyed by the corresponding `Context.Tag`. Use these when a test
// runs an Effect program against a full service graph — swap a single
// service by merging the fake layer over the live one.

export const fakeAuthServiceLayer = (
  impl: Partial<AuthService>,
): Layer.Layer<AuthServiceTag> =>
  Layer.succeed(AuthServiceTag, makeFakeService<AuthService>(impl));

export const fakeParticipantServiceLayer = (
  impl: Partial<ParticipantService>,
): Layer.Layer<ParticipantServiceTag> =>
  Layer.succeed(
    ParticipantServiceTag,
    makeFakeService<ParticipantService>(impl),
  );

export const fakeConversationServiceLayer = (
  impl: Partial<ConversationService>,
): Layer.Layer<ConversationServiceTag> =>
  Layer.succeed(
    ConversationServiceTag,
    makeFakeService<ConversationService>(impl),
  );

export const fakeDeliveryServiceLayer = (
  impl: Partial<DeliveryService>,
): Layer.Layer<DeliveryServiceTag> =>
  Layer.succeed(DeliveryServiceTag, makeFakeService<DeliveryService>(impl));

export const fakePresenceServiceLayer = (
  impl: Partial<PresenceService>,
): Layer.Layer<PresenceServiceTag> =>
  Layer.succeed(PresenceServiceTag, makeFakeService<PresenceService>(impl));

export const fakeMessageServiceLayer = (
  impl: Partial<MessageService>,
): Layer.Layer<MessageServiceTag> =>
  Layer.succeed(MessageServiceTag, makeFakeService<MessageService>(impl));

export const fakeAppHostLayer = (
  impl: Partial<AppHost>,
): Layer.Layer<AppHostTag> =>
  Layer.succeed(AppHostTag, makeFakeService<AppHost>(impl));

export const fakeDefaultPermissionServiceLayer = (
  impl: Partial<DefaultPermissionService>,
): Layer.Layer<DefaultPermissionServiceTag> =>
  Layer.succeed(
    DefaultPermissionServiceTag,
    makeFakeService<DefaultPermissionService>(impl),
  );

export const fakeConnectionManagerLayer = (
  impl: Partial<ConnectionManager>,
): Layer.Layer<ConnectionManagerTag> =>
  Layer.succeed(ConnectionManagerTag, makeFakeService<ConnectionManager>(impl));

export const fakeBroadcasterLayer = (
  impl: Partial<Broadcaster>,
): Layer.Layer<BroadcasterTag> =>
  Layer.succeed(BroadcasterTag, makeFakeService<Broadcaster>(impl));
