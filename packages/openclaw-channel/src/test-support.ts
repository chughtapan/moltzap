/**
 * `@moltzap/openclaw-channel/test-support` — narrow public subpath
 * export so the protocol conformance suite can instantiate a real
 * MoltZap WS client in the shape OpenClaw ships (AC16).
 *
 * Architect-201 §8 O5: the channel plugin embeds `MoltZapChannelCore`
 * (which internally composes `MoltZapWsClient`) via a private path. A
 * conformance wrapper would need to reach through that plugin surface
 * to exercise the client directly. Instead, this module re-uses the
 * client adapter shipped by `@moltzap/client/test-utils` (which is the
 * transport core all three consumers share) — keeping the plugin's
 * public contract unchanged.
 */
export {
  createMoltZapRealClientFactory,
  type RealClientFactoryOptions,
} from "@moltzap/client/test-utils";
