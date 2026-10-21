The live wire window holds the emitted wire version and at most one adjacent
version. A wire bump spans two releases: the first admits the successor while
still emitting the current version, and the second emits the successor while
still admitting its predecessor, which the next release stops admitting. Any
two adjacent releases of the daemon, the Registry and the Router therefore
interoperate in either upgrade order, and the mixed-release gate checks the
current daemon through the previous release's Registry and Router.
