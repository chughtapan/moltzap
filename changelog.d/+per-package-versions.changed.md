Each published package now carries its own calendar version. A release
publishes only the packages whose packed content changed since their last
published version, plus every package that depends on one of them, and each
published package still pins its siblings to exact versions. Every published
manifest records `sharnessContentHash`, a hash of the packed files and manifest
without its version, and `@moltzap/openclaw-channel` also records
`sharnessHostCodeHash`, a hash of the code OpenClaw loads for it, which a
change confined to the daemon leaves unchanged. The first release after this
change republishes all four packages, because no earlier version records a
hash. Install `@moltzap/client` or `@moltzap/openclaw-channel` and let their
pins choose the other packages, rather than requesting one version of every
package.
