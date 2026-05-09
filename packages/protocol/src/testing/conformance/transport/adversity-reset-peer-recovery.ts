/**
 * reset_peer — mid-flight the toxic forcibly resets the connection.
 * Spec invariant: sender's RPCs surface a typed `TransportClosedError`,
 * never hang, never crash. Full store-and-replay (reconnect + missed-
 * event replay) is a consumer-side concern driven by each real client
 * against `TestServer`; protocol-level guarantee is that the TestClient
 * surfaces the transport failure as a typed outcome.
 */
import { Clock, Effect, Either } from "effect";
import { defaultToxicProfile } from "../../toxics/defaults.js";
import { TransportClosedError } from "../../errors.js";
import { ConversationsList } from "../../../task/methods.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyUnavailable } from "../_shared/registry.js";
import {
  ADVERSITY_CATEGORY,
  acquireProxiedClient,
  proxyName,
  withToxicProxy,
} from "./_helpers.js";

const RESET_CLIENT_TIMEOUT_MS = 4_000;
const RESET_POLL_ATTEMPTS = 10;
const RESET_CLOSE_BUDGET_MS = 3_500;

export function registerResetPeerRecovery(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "reset-peer-recovery",
    description: "reset_peer surfaces TransportClosedError without hanging",
    proxyName: proxyName("rst", ctx.seed),
    profile: defaultToxicProfile.reset_peer,
    body: ({ proxy, unavailable, attachToxic }) =>
      Effect.gen(function* () {
        const sender = yield* acquireProxiedClient(
          ctx,
          proxy,
          `rst-${ctx.seed}-s`,
          // Deadline > reset_peer.timeoutMs (2000); bounded so a
          // never-firing reset doesn't hang the suite.
          RESET_CLIENT_TIMEOUT_MS,
          unavailable,
        );
        const observed = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* attachToxic;
            const start = yield* Clock.currentTimeMillis;
            for (let i = 0; i < RESET_POLL_ATTEMPTS; i++) {
              const outcome = yield* sender.client
                .sendRpc(ConversationsList, {})
                .pipe(Effect.either);
              const transportClosed = Either.match(outcome, {
                onLeft: (error) => error instanceof TransportClosedError,
                onRight: () => false,
              });
              if (transportClosed) {
                return true;
              }
              yield* Effect.sleep("300 millis");
              const elapsed = (yield* Clock.currentTimeMillis) - start;
              if (elapsed > RESET_CLOSE_BUDGET_MS) return false;
            }
            return false;
          }),
        );
        if (!observed) {
          return yield* Effect.fail(
            new PropertyUnavailable({
              category: ADVERSITY_CATEGORY,
              name: "reset-peer-recovery",
              reason: "reset_peer toxic did not close within 3.5s budget",
            }),
          );
        }
      }),
  });
}
