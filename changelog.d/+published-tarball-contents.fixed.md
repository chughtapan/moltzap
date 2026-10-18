The `@moltzap/openclaw-channel` tarball no longer ships the 948 kB TypeScript
build-info file, and every published package rebuilds its `dist/` from scratch,
so a removed module can no longer ship in a release tarball.
