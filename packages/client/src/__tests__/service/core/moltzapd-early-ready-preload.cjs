const READY_MESSAGE_TYPE = "moltzapd.ready";

// This fault-injection preload signals before daemon acquisition so the
// supervisor's endpoint identity check is exercised independently of binding.
if (process.send !== undefined) {
  process.send({ type: READY_MESSAGE_TYPE });
}
