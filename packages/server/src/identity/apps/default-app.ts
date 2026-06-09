import { Effect, Schema } from "effect";
import type { RpcSerialization } from "@effect/rpc";
import type { AppManifest } from "@moltzap/protocol/identity";
import { ConnectionId } from "@moltzap/protocol/socket";
import { DEFAULT_APP_ID } from "@moltzap/protocol/task";
import type { AppHost } from "./host.js";
import type { AppEndpoint } from "./registry.js";
import type { Originator } from "#socket";

/**
 * Connection id for the boot-installed default app — server-minted so
 * no client `crypto.randomUUID()` can ever collide with the default
 * app's registered endpoint connId.
 */
const DEFAULT_APP_CONNECTION_ID = Schema.decodeUnknownSync(ConnectionId)(
  "00000000-0000-4000-8000-000000000001",
);

/**
 * The boot-installed default app declares the three open policies
 * explicitly:
 *
 *   - `dispatch_authorize: { kind: "grant" }` — unmoderated admission.
 *   - `message_authorize: { kind: "forwardAllExceptSender" }` — fan out
 *     to every participant except the sender, computed in-process via
 *     `ConversationService.getParticipantAgentIds`.
 *   - `task_create: { kind: "accept" }` — auto-accept every task.
 *
 * Each policy is a static arm AppHost resolves in-process, so
 * `AppHost.callAppRpc` is never reached for `DEFAULT_APP_ID` and the
 * endpoint's `originator` is never invoked. The registration still
 * needs an {@link AppEndpoint} for its `connId` (close-time keying), so
 * the default app carries an inert endpoint whose outbound channel
 * defects — any call is a wiring bug (a `kind: "hook"` arm fired
 * against a static-only manifest) that should crash the server
 * immediately.
 */
const DEFAULT_APP_MANIFEST = {
  appId: DEFAULT_APP_ID,
  name: "Default",
  hooks: {
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "forwardAllExceptSender" },
    task_create: { kind: "accept" },
  },
} satisfies AppManifest;

function inertOriginatorOp(op: string): Effect.Effect<never> {
  return Effect.die(
    new Error(
      `default app endpoint: ${op} invoked — the default app declares only static policies, so its originator must never be called`,
    ),
  );
}

function makeInertParser(op: string): RpcSerialization.Parser {
  const fail = () =>
    Effect.runSync(
      Effect.dieMessage(
        `default app endpoint: ${op} invoked — the default app serves no reverse protocol frames`,
      ),
    );
  return {
    decode: fail,
    encode: fail,
  };
}

/**
 * Build the inert {@link AppEndpoint} for the default app. Every policy
 * is a static arm resolved in-process, so the originator is never
 * invoked and every method defects.
 */
function makeDefaultAppEndpoint(): AppEndpoint {
  const originator: Originator = {
    call: () => inertOriginatorOp("originator.call"),
    callback: () => inertOriginatorOp("originator.callback"),
    notify: () => inertOriginatorOp("originator.notify"),
    // The inert endpoint serves no inbound s2c frames; its sink is never
    // routed to (the default app makes no round-trips).
    sink: {
      parser: makeInertParser("originator.sink.parser"),
      inject: () => inertOriginatorOp("originator.sink.inject"),
    },
  };
  return {
    connId: DEFAULT_APP_CONNECTION_ID,
    originator,
  };
}

/**
 * Boot-time installation of the default app. Registers the static-only
 * manifest under {@link DEFAULT_APP_ID}; AppHost resolves every policy
 * verdict in-process (see {@link DEFAULT_APP_MANIFEST}). No app
 * round-trip is ever made.
 *
 * TM-admin RPCs (rebound to the app principal) remain unreachable on
 * `DEFAULT_APP_ID` tasks because no client `AppConnection` can ever own
 * the default app — its endpoint is a server-minted inert endpoint, not
 * a connected HTTP-registered app.
 *
 * No `ConversationService` arg: the `forwardAllExceptSender` policy
 * reads participants through the ConversationService back-edge AppHost
 * already holds (wired by `server.ts → setConversationService`
 * immediately before this call).
 */
export function installDefaultApp(appHost: AppHost): void {
  appHost.registerApp(
    DEFAULT_APP_ID,
    DEFAULT_APP_MANIFEST,
    makeDefaultAppEndpoint(),
  );
}
