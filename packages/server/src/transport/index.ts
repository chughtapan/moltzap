// transport/ — wire-level dispatch.
//
// Public barrel for the transport layer. Post-Phase-2A.2, this layer
// owns ws/ + rpc/ contents (frame codec, RPC routing, connection
// manager). Skeleton stage: empty barrel; symbols land in 2A.2.
//
// Layer rule (architectureOptions, Phase 4): transport may import from
// _infra/ only. transport may NOT import from identity, network, task,
// or app. Higher layers reach transport via subpath exports.

export {};
