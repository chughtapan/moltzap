// _infra/ — shared horizontals. Bottom layer of the stack.
//
// Public barrel for the cross-cutting infrastructure layer. Post-
// Phase-2A.2 contents: db/, crypto/, config/, runtime/,
// runtime-surface/, adapters/, test-utils/ — all current top-level
// folders in packages/server/src/ that are NOT protocol layers.
//
// Layer rule (Q-infra-layer-position, architectureOptions): _infra is
// the bottom-most named layer. ANY layer may import from _infra; _infra
// may NOT import from any layer above it (transport, identity,
// network, task, app). Architecture lint enforces both directions.

export {};
