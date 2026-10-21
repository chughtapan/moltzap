Each published package now carries its own calendar version. A release
publishes only the packages whose packed content changed since their last
published version, plus every package that depends on one of them, and each
published package still pins its siblings to exact versions. Every published
manifest records `sharnessContentHash`, a hash of the packed files and manifest
without its version, so two versions of a package with equal hashes carry the
same code. Install `@moltzap/client` or `@moltzap/openclaw-channel` and let
their pins choose the other packages, rather than requesting one version of
every package.
