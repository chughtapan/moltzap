#!/usr/bin/env bash
set -euo pipefail

# Pack server-core into a tarball
TARBALL=$(cd packages/server && pnpm pack --pack-destination /tmp 2>/dev/null | tail -1)
echo "Packed: $TARBALL"

# Create temp project
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

cd "$TMPDIR"
cat > package.json << 'PKGJSON'
{ "name": "test-consumer", "type": "module", "private": true }
PKGJSON

cat > tsconfig.json << 'TSCONF'
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2022",
    "strict": true,
    "noEmit": true
  }
}
TSCONF

# Install the tarball and the compiler used by the consumer smoke test.
npm install "$TARBALL" @moltzap/protocol@latest typescript@latest 2>&1 | tail -3

# Write a consumer that verifies the intentional public surface.
cat > consumer.ts << 'CONSUMER'
import * as serverCore from "@moltzap/server-core";
import {
  startCoreTestServer,
  stopCoreTestServer,
  type CoreTestServer,
} from "@moltzap/server-core/test-utils";

type _emptyRoot = keyof typeof serverCore extends never ? true : never;
type _testServer = CoreTestServer;
type _start = typeof startCoreTestServer;
type _stop = typeof stopCoreTestServer;

const rootIsEmpty: _emptyRoot = true;
void rootIsEmpty;

console.log("All imports resolved successfully");
CONSUMER

# Compile — this catches missing exports, broken type declarations
./node_modules/.bin/tsc --noEmit 2>&1
echo "PASS: Pack + install + compile succeeded"
