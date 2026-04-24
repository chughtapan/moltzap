/**
 * `@moltzap/nanoclaw-channel/test-support` — narrow public subpath
 * export so the protocol conformance suite can instantiate a real
 * MoltZap WS client in the shape the nanoclaw channel ships (AC17).
 *
 * Architect-201 §8 O5: mirror of the openclaw test-support module. The
 * channel embeds `MoltZapChannelCore`+`MoltZapService` inside a private
 * `MoltZapChannel` field; the conformance wrapper exercises the
 * transport core via `@moltzap/client/test-utils` rather than
 * reshaping the plugin's public contract.
 */
export {
  createMoltZapRealClientFactory,
  type RealClientFactoryOptions,
} from "@moltzap/client/test-utils";
