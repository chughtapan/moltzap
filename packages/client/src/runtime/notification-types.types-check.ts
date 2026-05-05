/**
 * Negative type-test canary for Phase 7.5c (#455).
 *
 * Locks the compiler-enforced lift contract that splits unvalidated
 * wire-decoder output (`RawDecodedNotification<D>`,
 * `DecodedNotificationFrame`) from validated typed-bridge surface
 * (`DecodedNotification<D>`).
 *
 * What we assert:
 *
 *   1. `subscribers.dispatch` accepts the raw / unknown-method union
 *      `DecodedNotificationFrame`. Validated `DecodedNotification<D>`
 *      values are still acceptable (subtype of `RawDecodedNotification<D>`),
 *      but a raw frame cannot reach the typed handler bucket without
 *      passing through `validateNotificationParams`.
 *
 *   2. `defineEffectNotificationHandlers(...).dispatch` (the typed
 *      handler dispatcher used by `MoltZapService`) refuses
 *      `RawDecodedNotification<D>` and the broader
 *      `DecodedNotificationFrame` union — only validated
 *      `DecodedNotification<D>` may flow in. This is the load-bearing
 *      negative: a regression that re-aliases the two types would
 *      surface here as a missing `@ts-expect-error`.
 *
 * Compile-only — no runtime test runner picks this file up. The
 * `@ts-expect-error` markers fail the build if they ever start
 * compiling cleanly.
 */
import { Effect } from "effect";
import {
  ConversationArchivedNotificationDefinition,
  bindNotificationHandler,
  defineEffectNotificationHandlers,
  defineNotificationGroup,
  type DecodedNotification,
  type DecodedNotificationFrame,
  type RawDecodedNotification,
} from "@moltzap/protocol";
import { makeSubscriberRegistry } from "./subscribers.js";

const noopLogger = { warn: () => {} };
const registry = Effect.runSync(makeSubscriberRegistry(noopLogger));
const canaryGroup = defineNotificationGroup("phase7.5c-canary", [
  ConversationArchivedNotificationDefinition,
] as const);
const typedHandlers = defineEffectNotificationHandlers(canaryGroup, [
  bindNotificationHandler(
    ConversationArchivedNotificationDefinition,
    () => Effect.void,
  ),
]);

declare const validatedFrame: DecodedNotification<
  typeof ConversationArchivedNotificationDefinition
>;
declare const rawFrame: RawDecodedNotification<
  typeof ConversationArchivedNotificationDefinition
>;
declare const wireUnion: DecodedNotificationFrame;

// --- Subscribers (raw|unknown) accept the wire-decoder union ---

void registry.dispatch(rawFrame); // OK: raw subtype of the union
void registry.dispatch(wireUnion); // OK: union dispatch
// Validated values are also accepted because `DecodedNotification<D>`
// is a subtype of `RawDecodedNotification<D>` (params narrower).
void registry.dispatch(validatedFrame);

// --- Typed dispatcher refuses pre-validation shapes ---

// @ts-expect-error - typed dispatcher rejects unvalidated raw frames; lift via `validateNotificationParams` first
void typedHandlers.dispatch(rawFrame);

// @ts-expect-error - typed dispatcher rejects the wire-decoder union (includes the unknown-method branch)
void typedHandlers.dispatch(wireUnion);

// Validated frame is accepted — proves the negative is not vacuous
// (a regression that aliases Decoded≡Raw would still pass this line
// but flip the `@ts-expect-error`s above).
void typedHandlers.dispatch(validatedFrame);

// --- UnknownDecodedNotification cannot impersonate a known descriptor ---

declare const unknownMethodFrame: Extract<
  DecodedNotificationFrame,
  { definition?: undefined }
>;

// @ts-expect-error - unknown-method branch has no descriptor; typed dispatcher requires `definition`
void typedHandlers.dispatch(unknownMethodFrame);
