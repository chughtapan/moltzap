// `InvalidParamsError` lives in `@moltzap/protocol` so the wire-error
// registry's class set (mirrored by the `RegisteredTaggedError` union)
// stays closed. Re-exported here for the existing `runtime/` import path.
export { InvalidParamsError } from "@moltzap/protocol";
