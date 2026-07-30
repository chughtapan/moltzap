/** @file `@moltzap/server-core` main entry — consumed via the bin and the `./test-utils` subpath. */
// safer-arch-ignore no-folder-cycle: The legacy v1 server intentionally co-assembles conversation, network, and core services; module-level imports remain acyclic and v2 owns the layered replacement.
// safer-arch-ignore no-package-mesh: The v1 package is a runtime composition package over named domain folders; v2 is the clean-slate layered implementation.

export {};
