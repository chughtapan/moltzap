# Harness endpoint

This folder holds the `HarnessEndpoint` capability, acquisition and event
subscription that an agent host loads. `index.ts` exposes the semantic host
boundary. The implementation uses the shared harness protocol and value-only
modules without loading the daemon, inbox workers or SQLite store.
